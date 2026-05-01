// ComfyUI-AutoSequentialFrames / web / auto_sequential_controller.js
//
// 🎯 Controller 节点（**覆盖式上传**模式）—— 完全不改原 LoadImage 的 widget 值
//
// 工作原理：
//   1) 用户先在 LoadImage 97 / 184 上各自上传一张占位图（widget 值是文件名，比如
//      "00115-1.jpg" 和 "00118-1.jpg"），这两个文件名就是"槽位"
//   2) 每次循环时，本插件把 directory 里第 N、N+1 张图的内容，
//      用 shutil.copyfile 覆盖到 input/00115-1.jpg 和 input/00118-1.jpg 上
//   3) LoadImage 的 widget 值丝毫不变 —— 但 ComfyUI 的 LoadImage 是基于
//      文件 SHA256 来判断是否需要重新加载的，文件内容一变它就会重新跑
//   4) 工作流 JSON 文件不会被改动，每次保存都是干净的

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "AutoSequentialController";
const ENDPOINT_SCAN   = "/auto_sequential/scan";
const ENDPOINT_INJECT = "/auto_sequential/inject";
const ENDPOINT_LINK   = "/auto_sequential/link";

const executedThisRun = new Set();

// ---------- 通用工具 ----------

function getWidget(node, name) {
    return node.widgets?.find(w => w.name === name);
}
function setWidgetValue(node, name, value) {
    const w = getWidget(node, name);
    if (!w) return false;
    w.value = value;
    if (typeof w.callback === "function") {
        try { w.callback(value); } catch (e) {}
    }
    return true;
}

// 递归找所有 LoadImage 节点（含 subgraph 内）
function findLoadImageNodes(graph, prefix = "") {
    const out = [];
    if (!graph) return out;
    const nodes = graph._nodes || graph.nodes || [];
    for (const node of nodes) {
        const pathId = prefix ? `${prefix}/${node.id}` : `${node.id}`;
        const t = node.type || "";
        const isLoadImage =
            t === "LoadImage" ||
            t === "LoadImageMask" ||
            (t.includes("LoadImage") && getWidget(node, "image"));
        if (isLoadImage) {
            const cur = getWidget(node, "image")?.value ?? "?";
            out.push({ pathId, node, display: `#${pathId} · ${node.title || t}  〈 ${cur} 〉` });
        }
        const inner = node.subgraph || node.graph;
        if (inner && inner !== graph) {
            out.push(...findLoadImageNodes(inner, pathId));
        }
    }
    return out;
}
function findNodeByPathId(graph, pathId) {
    if (!pathId) return null;
    const parts = String(pathId).split("/").filter(x => x);
    let cur = graph, curNode = null;
    for (const part of parts) {
        const nodes = cur?._nodes || cur?.nodes || [];
        curNode = nodes.find(n => String(n.id) === String(part));
        if (!curNode) return null;
        cur = curNode.subgraph || curNode.graph;
    }
    return curNode;
}

// ---------- 选 LoadImage 弹窗 ----------

async function pickLoadImageDialog(title) {
    const cands = findLoadImageNodes(app.graph);
    if (cands.length === 0) { alert("画布上没找到任何 LoadImage 节点"); return null; }
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center;`;
        const dlg = document.createElement("div");
        dlg.style.cssText = `background:#2a2a2a;color:#fff;padding:20px;border-radius:8px;border:1px solid #555;min-width:420px;max-width:80vw;max-height:70vh;overflow-y:auto;font-family:sans-serif;font-size:13px;`;
        const h = document.createElement("h3");
        h.textContent = title;
        h.style.cssText = "margin:0 0 12px 0;font-size:15px;";
        dlg.appendChild(h);
        for (const c of cands) {
            const b = document.createElement("button");
            b.textContent = c.display;
            b.style.cssText = `display:block;width:100%;margin:4px 0;padding:8px 10px;background:#3a3a3a;color:#eee;border:1px solid #555;border-radius:4px;text-align:left;cursor:pointer;font-family:monospace;font-size:12px;`;
            b.onmouseenter = () => b.style.background = "#4a4a4a";
            b.onmouseleave = () => b.style.background = "#3a3a3a";
            b.onclick = () => { document.body.removeChild(overlay); resolve(c.pathId); };
            dlg.appendChild(b);
        }
        const inp = document.createElement("input");
        inp.placeholder = "或直接输入 ID（如 97，或 129/97）";
        inp.style.cssText = "width:100%;margin-top:10px;padding:8px;background:#1a1a1a;color:#fff;border:1px solid #555;border-radius:4px;";
        dlg.appendChild(inp);
        const okBtn = document.createElement("button");
        okBtn.textContent = "✅ 用输入的 ID";
        okBtn.style.cssText = "display:block;width:100%;margin-top:6px;padding:8px;background:#2a5a2a;color:#fff;border:1px solid #4a7a4a;border-radius:4px;cursor:pointer;";
        okBtn.onclick = () => { const v = inp.value.trim(); if (!v) return; document.body.removeChild(overlay); resolve(v); };
        dlg.appendChild(okBtn);
        const cancel = document.createElement("button");
        cancel.textContent = "取消";
        cancel.style.cssText = "display:block;width:100%;margin-top:6px;padding:8px;background:#5a2a2a;color:#fff;border:1px solid #7a4a4a;border-radius:4px;cursor:pointer;";
        cancel.onclick = () => { document.body.removeChild(overlay); resolve(null); };
        dlg.appendChild(cancel);
        overlay.appendChild(dlg);
        overlay.onclick = (e) => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(null); } };
        document.body.appendChild(overlay);
        inp.focus();
    });
}

// ---------- 后端调用 ----------

async function scanFor(node) {
    const dir = getWidget(node, "directory")?.value || "";
    const pat = getWidget(node, "pattern")?.value || "*.jpg;*.png";
    const sort = getWidget(node, "sort_method")?.value || "natural";
    if (!dir) return null;
    try {
        const res = await fetch(ENDPOINT_SCAN, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ directory: dir, pattern: pat, sort_method: sort }),
        });
        return await res.json();
    } catch (e) { console.error("[AutoSeq Ctrl] scan failed:", e); return null; }
}

async function injectFile(srcAbsPath, dstFilename) {
    try {
        const res = await fetch(ENDPOINT_INJECT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ src: srcAbsPath, dst: dstFilename }),
        });
        return await res.json();
    } catch (e) { return { ok: false, error: String(e) }; }
}

async function createLink(srcPath) {
    try {
        const res = await fetch(ENDPOINT_LINK, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ src: srcPath }),
        });
        return await res.json();
    } catch (e) { return { ok: false, error: String(e) }; }
}

// ---------- 强制刷新 LoadImage 的预览图 ----------
//
// 文件内容变了，但 widget 值没变；浏览器/ComfyUI 可能用缓存的预览图。
// 这里清掉节点缓存 + 重新触发 image widget 的 callback。

function refreshLoadImagePreview(node) {
    if (!node) return;
    try { node.imgs = null; node.imageIndex = 0; } catch (e) {}
    const w = getWidget(node, "image");
    if (w && typeof w.callback === "function") {
        try { w.callback(w.value); } catch (e) {}
    }
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

// ---------- 状态行 ----------

function updateStatus(node, text) {
    if (node._statusWidget) {
        node._statusWidget.value = text;
        node.setDirtyCanvas(true, true);
    }
}

// ---------- 核心：根据当前 index 把首尾帧"覆盖上传"到目标 LoadImage 的槽位 ----------

async function applyCurrentPair(node, opts = {}) {
    const data = await scanFor(node);
    if (!data) {
        updateStatus(node, "❌ 扫描失败（看 F12 控制台 + ComfyUI 黑窗口日志）");
        return false;
    }
    if (data.error) { updateStatus(node, `❌ 后端错误: ${data.error}`); return false; }
    if (!data.exists) { updateStatus(node, `❌ 目录不存在: ${data.directory}`); return false; }
    if (data.count < 2) { updateStatus(node, `⚠️ 仅 ${data.count} 张图片，无法配对`); return false; }

    const idx = getWidget(node, "current_index")?.value ?? 0;
    const step = getWidget(node, "step")?.value ?? 1;
    const loop = !!getWidget(node, "loop_when_done")?.value;

    let i1, i2;
    if (loop) {
        i1 = idx % data.count;
        i2 = (idx + step) % data.count;
    } else {
        if (idx + step > data.count - 1) {
            updateStatus(node, `✅ 已遍历完 ${data.count} 张图片`);
            return false;
        }
        i1 = idx; i2 = idx + step;
    }

    const f1 = data.files[i1];
    const f2 = data.files[i2];

    // 源文件绝对路径（resolved 是后端返回的 abs_dir）
    const sep = data.resolved.includes("\\") ? "\\" : "/";
    const src1 = data.resolved.replace(/[/\\]+$/, "") + sep + f1;
    const src2 = data.resolved.replace(/[/\\]+$/, "") + sep + f2;

    // 目标 LoadImage 节点
    const firstId = String(getWidget(node, "first_node_id")?.value || "").trim();
    const lastId  = String(getWidget(node, "last_node_id")?.value  || "").trim();
    if (!firstId || !lastId) {
        updateStatus(node, "⚠️ 还没选 LoadImage 节点（点上面 📋 按钮）");
        return false;
    }
    const firstNode = findNodeByPathId(app.graph, firstId);
    const lastNode  = findNodeByPathId(app.graph, lastId);
    if (!firstNode) { updateStatus(node, `❌ 找不到 LoadImage #${firstId}`); return false; }
    if (!lastNode)  { updateStatus(node, `❌ 找不到 LoadImage #${lastId}`); return false; }

    // 读 LoadImage 当前的 image widget 值，作为"槽位文件名"（dst）
    const slot1 = getWidget(firstNode, "image")?.value;
    const slot2 = getWidget(lastNode, "image")?.value;
    if (!slot1 || !slot2) {
        updateStatus(node,
            `⚠️ 目标 LoadImage 还没上传任何图作占位。` +
            `请先在 LoadImage #${firstId} / #${lastId} 各自手动上传一张图（任意图）作为槽位。`
        );
        return false;
    }
    if (slot1 === slot2) {
        updateStatus(node,
            `⚠️ 两个 LoadImage 的占位文件名重复 (都是 ${slot1})。` +
            `请给它们上传不同文件名的占位图。`
        );
        return false;
    }

    // 调 inject 接口：把源文件覆盖到 input/<slot>
    const r1 = await injectFile(src1, slot1);
    const r2 = await injectFile(src2, slot2);

    if (!r1.ok) { updateStatus(node, `❌ 覆盖首帧失败: ${r1.error}`); return false; }
    if (!r2.ok) { updateStatus(node, `❌ 覆盖尾帧失败: ${r2.error}`); return false; }

    // 让 LoadImage 重新拉预览图（视觉上看见新图）
    refreshLoadImagePreview(firstNode);
    refreshLoadImagePreview(lastNode);

    const totalPairs = data.count - step;
    updateStatus(node,
        `✅ ${f1} → 槽位[${slot1}]  &  ${f2} → 槽位[${slot2}]   ` +
        `进度 ${i1 + 1}/${totalPairs}`
    );
    return true;
}

// ---------- 注册 ----------

app.registerExtension({
    name: "ComfyUI.AutoSequentialController",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated?.apply(this, arguments);

            this.addWidget("button", "📋 选择首帧 LoadImage (按 ID)", null, async () => {
                const id = await pickLoadImageDialog("选择首帧 LoadImage 节点");
                if (id) {
                    setWidgetValue(this, "first_node_id", id);
                    updateStatus(this, `首帧已绑定到 #${id}`);
                }
            });

            this.addWidget("button", "📋 选择尾帧 LoadImage (按 ID)", null, async () => {
                const id = await pickLoadImageDialog("选择尾帧 LoadImage 节点");
                if (id) {
                    setWidgetValue(this, "last_node_id", id);
                    updateStatus(this, `尾帧已绑定到 #${id}`);
                }
            });

            this.addWidget("button", "🔄 应用当前 index（覆盖到 LoadImage）", null, async () => {
                await applyCurrentPair(this);
            });

            this.addWidget("button", "🔗 (可选) 把目录链接进 input/", null, async () => {
                const dir = getWidget(this, "directory")?.value || "";
                if (!dir) { alert("请先填 directory（绝对路径）"); return; }
                const r = await createLink(dir);
                if (r.ok) {
                    updateStatus(this, `🔗 ${r.msg || "已链接"}`);
                } else {
                    alert("链接失败: " + (r.error || "未知错误"));
                }
            });

            this.addWidget("button", "⏮ 重置 current_index 为 0", null, () => {
                setWidgetValue(this, "current_index", 0);
                applyCurrentPair(this);
            });

            this.addWidget("button", "▶ 立即开始（应用 + 队列一次）", null, async () => {
                const ok = await applyCurrentPair(this);
                if (ok) setTimeout(() => app.queuePrompt(0, 1), 250);
            });

            this.addWidget("button", "⏭ 跳过当前对（仅 +step）", null, () => {
                const cur = getWidget(this, "current_index")?.value ?? 0;
                const step = getWidget(this, "step")?.value ?? 1;
                setWidgetValue(this, "current_index", cur + step);
                applyCurrentPair(this);
            });

            this._statusWidget = this.addWidget(
                "text", "状态",
                "（① 在 LoadImage 上传任意占位图 ② 选 LoadImage 节点 ③ 填 directory ④ 点 🔄）",
                () => {},
                { serialize: false }
            );

            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = onConfigure?.apply(this, arguments);
            setTimeout(() => applyCurrentPair(this).catch(() => {}), 500);
            return r;
        };
    },

    async setup() {
        api.addEventListener("execution_start", () => executedThisRun.clear());
        api.addEventListener("executing", ({ detail }) => {
            if (detail !== null && detail !== undefined) executedThisRun.add(String(detail));
        });

        api.addEventListener("execution_success", async () => {
            const myNodes = (app.graph?._nodes || []).filter(n => n.type === NODE_TYPE);
            for (const node of myNodes) {
                if (!executedThisRun.has(String(node.id))) continue;

                if (!getWidget(node, "auto_advance")?.value) {
                    await applyCurrentPair(node);
                    continue;
                }

                const cur = getWidget(node, "current_index")?.value ?? 0;
                const step = getWidget(node, "step")?.value ?? 1;
                const newIdx = cur + step;
                setWidgetValue(node, "current_index", newIdx);
                console.log(`[AutoSeq Ctrl] node #${node.id} 推进 → ${newIdx}`);

                const ok = await applyCurrentPair(node);
                if (!ok) { console.log("[AutoSeq Ctrl] 应用失败或到达末尾"); continue; }

                if (!getWidget(node, "auto_queue")?.value) continue;
                setTimeout(() => {
                    app.queuePrompt(0, 1);
                    console.log(`[AutoSeq Ctrl] 自动队列下一次 (idx=${newIdx})`);
                }, 300);
            }
        });

        api.addEventListener("execution_error", () => {
            console.warn("[AutoSeq Ctrl] 执行错误，自动队列已停止");
        });
    },
});
