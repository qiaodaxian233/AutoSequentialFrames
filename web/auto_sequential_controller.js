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
const ENDPOINT_SCAN     = "/auto_sequential/scan";
const ENDPOINT_INJECT   = "/auto_sequential/inject";
const ENDPOINT_LINK     = "/auto_sequential/link";
const ENDPOINT_TAIL     = "/auto_sequential/extract_tail_frame";
const ENDPOINT_REGISTER = "/auto_sequential/register_video";
const ENDPOINT_LIST     = "/auto_sequential/list_videos";
const ENDPOINT_POP      = "/auto_sequential/pop_last_video";
const ENDPOINT_CLEAR    = "/auto_sequential/clear_history";

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
        inp.placeholder = "或直接输入 ID（如 97,或 129/97）";
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

// ---------- 选视频弹窗（用于「选视频抽尾帧」）----------

function _formatTime(unixSec) {
    if (!unixSec) return "?";
    try {
        const d = new Date(unixSec * 1000);
        const pad = (n) => String(n).padStart(2, "0");
        return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch (e) { return "?"; }
}

async function pickVideoDialog(node, title) {
    const resp = await listVideos(node);
    if (!resp.ok) { alert("读取视频历史失败: " + (resp.error || "?")); return null; }
    const videos = resp.videos || [];
    if (videos.length === 0) {
        alert("本会话还没有登记过视频。\n先点 ▶ 立即开始 跑一段视频，或者用「应用尾帧对」走一次扫盘流程。");
        return null;
    }

    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center;`;
        const dlg = document.createElement("div");
        dlg.style.cssText = `background:#2a2a2a;color:#fff;padding:20px;border-radius:8px;border:1px solid #555;min-width:520px;max-width:80vw;max-height:75vh;overflow-y:auto;font-family:sans-serif;font-size:13px;`;
        const h = document.createElement("h3");
        h.textContent = title || "选一段视频抽尾帧";
        h.style.cssText = "margin:0 0 6px 0;font-size:15px;";
        dlg.appendChild(h);

        const sub = document.createElement("div");
        sub.textContent = `本会话已登记 ${videos.length} 段视频（最新的在最下面）`;
        sub.style.cssText = "color:#aaa;font-size:11px;margin-bottom:10px;";
        dlg.appendChild(sub);

        // 倒序展示：最新的在上面更易点
        const list = videos.slice().reverse();
        list.forEach((v, idx) => {
            const seg = (v.segment_index !== undefined && v.segment_index !== null)
                ? `#${v.segment_index}` : "";
            const exists = !!v.exists;
            const b = document.createElement("button");
            const time = _formatTime(v.mtime);
            const fname = v.video_basename || (v.video_path || "").split(/[\/\\]/).pop() || "?";
            const pair = (v.first_filename || v.last_filename)
                ? ` ⟵ (${v.first_filename || "?"} → ${v.last_filename || "?"})`
                : "";
            b.innerHTML = (exists ? "" : "🚫 ") +
                `<b>${seg}</b>  ${fname}  <span style="color:#9c9">${v.resolution || ""}</span>  ` +
                `<span style="color:#888">${time}</span>` +
                `<span style="color:#777;font-size:11px">${pair}</span>`;
            b.disabled = !exists;
            b.title = v.video_path || "";
            b.style.cssText = `display:block;width:100%;margin:4px 0;padding:8px 10px;` +
                `background:${exists ? '#3a3a3a' : '#2a1a1a'};color:${exists ? '#eee' : '#888'};` +
                `border:1px solid #555;border-radius:4px;text-align:left;` +
                `cursor:${exists ? 'pointer' : 'not-allowed'};font-family:monospace;font-size:12px;`;
            if (exists) {
                b.onmouseenter = () => b.style.background = "#4a4a4a";
                b.onmouseleave = () => b.style.background = "#3a3a3a";
                b.onclick = () => { document.body.removeChild(overlay); resolve(v.video_path); };
            }
            dlg.appendChild(b);
        });

        const cancel = document.createElement("button");
        cancel.textContent = "取消";
        cancel.style.cssText = "display:block;width:100%;margin-top:10px;padding:8px;background:#5a2a2a;color:#fff;border:1px solid #7a4a4a;border-radius:4px;cursor:pointer;";
        cancel.onclick = () => { document.body.removeChild(overlay); resolve(null); };
        dlg.appendChild(cancel);

        overlay.appendChild(dlg);
        overlay.onclick = (e) => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(null); } };
        document.body.appendChild(overlay);
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

// 尾帧模式：抽某段视频的最后一帧 → 覆盖写入 input/<dstFilename>
//
// 两种调用：
//   ① 不传 explicitVideoPath → 后端按 since_timestamp + target_resolution 自动找最新匹配
//   ② 传 explicitVideoPath → 直接用指定视频 (用于「选视频抽尾帧」「上一对」回退)
async function extractTailFrameToSlot(node, dstFilename, sinceTimestamp, explicitVideoPath = "") {
    const targetRes = (getWidget(node, "target_resolution")?.value || "1920x1088").trim();
    const outDir = (getWidget(node, "output_dir")?.value || "").trim();

    // 解析 "1920x1088" / "1920*1088" / "1920×1088"
    const m = targetRes.match(/(\d+)\s*[xX*×]\s*(\d+)/);
    if (!m && !explicitVideoPath) {
        return { ok: false, error: `target_resolution 格式无效: ${targetRes}（应为 "1920x1088" 这种）` };
    }
    const tw = m ? parseInt(m[1]) : 0;
    const th = m ? parseInt(m[2]) : 0;

    try {
        const res = await fetch(ENDPOINT_TAIL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                output_dir: outDir,
                target_width: tw,
                target_height: th,
                since_timestamp: sinceTimestamp || 0,
                dst_filename: dstFilename,
                video_path: explicitVideoPath || "",
            }),
        });
        return await res.json();
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

// 视频历史相关 API
async function registerLastVideo(node, segmentIndex, firstFilename, lastFilename) {
    const targetRes = (getWidget(node, "target_resolution")?.value || "1920x1088").trim();
    const outDir = (getWidget(node, "output_dir")?.value || "").trim();
    const m = targetRes.match(/(\d+)\s*[xX*×]\s*(\d+)/);
    const tw = m ? parseInt(m[1]) : 1920;
    const th = m ? parseInt(m[2]) : 1088;

    try {
        const res = await fetch(ENDPOINT_REGISTER, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                controller_id: String(node.id),
                output_dir: outDir,
                target_width: tw,
                target_height: th,
                since_timestamp: node._sessionStartTime || 0,
                segment_index: segmentIndex,
                first_filename: firstFilename || "",
                last_filename: lastFilename || "",
            }),
        });
        return await res.json();
    } catch (e) { return { ok: false, error: String(e) }; }
}

async function listVideos(node) {
    try {
        const res = await fetch(ENDPOINT_LIST, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ controller_id: String(node.id) }),
        });
        return await res.json();
    } catch (e) { return { ok: false, error: String(e), videos: [] }; }
}

async function popLastVideo(node) {
    try {
        const res = await fetch(ENDPOINT_POP, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ controller_id: String(node.id) }),
        });
        return await res.json();
    } catch (e) { return { ok: false, error: String(e) }; }
}

async function clearHistory(node) {
    try {
        const res = await fetch(ENDPOINT_CLEAR, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ controller_id: String(node.id) }),
        });
        return await res.json();
    } catch (e) { return { ok: false, error: String(e) }; }
}

// ---------- 强制刷新 LoadImage 的预览图（保护节点位置/尺寸不变）----------
//
// 直接 set node.imgs = null + 重新 callback 会导致 LoadImage 按新图的宽高比
// 重算节点尺寸，然后整个画布的相对布局就被挤歪了。
// 解决：操作前保存 size + pos，操作后用 setTimeout 多次恢复回去（防止 LoadImage
// 异步加载完图片后又改尺寸）。

function refreshLoadImagePreview(node) {
    if (!node) return;

    // 1) 保存当前几何信息
    const savedPos = node.pos ? [node.pos[0], node.pos[1]] : null;
    const savedSize = node.size ? [node.size[0], node.size[1]] : null;

    // 2) 锁定 onResize（如果 LoadImage 想自动调整尺寸，挡掉）
    const origOnResize = node.onResize;
    node.onResize = function () { /* 拒绝自动 resize */ };

    // 3) 触发 widget callback 让 LoadImage 重新拉预览图
    //    （ComfyUI 内置 imageUpload widget 会自动加 rand 参数防浏览器缓存）
    const w = getWidget(node, "image");
    if (w && typeof w.callback === "function") {
        try { w.callback(w.value); } catch (e) {}
    }

    // 4) 多次恢复几何信息：图片可能要等几十毫秒才异步加载完，
    //    LoadImage 拿到图后还会再尝试 resize 一次，需要在不同时刻多挡几次
    const restore = () => {
        if (savedPos && node.pos) { node.pos[0] = savedPos[0]; node.pos[1] = savedPos[1]; }
        if (savedSize && node.size) { node.size[0] = savedSize[0]; node.size[1] = savedSize[1]; }
        node.setDirtyCanvas?.(true, false);
    };
    restore();
    setTimeout(restore, 50);
    setTimeout(restore, 200);
    setTimeout(() => {
        restore();
        // 最后把 onResize 还原回去（让用户能正常拖角调大小）
        node.onResize = origOnResize;
    }, 800);
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

// ---------- 尾帧模式：用上一段视频的最后一帧覆盖首帧槽位，目录里的下一张图覆盖尾帧槽位 ----------
//
// opts.explicitVideoPath: 强制使用指定视频抽尾帧 (来自「选视频抽尾帧」/「上一对」)
//                         不传则按 sinceTimestamp 扫盘自动选最新匹配的

async function applyTailPair(node, opts = {}) {
    const data = await scanFor(node);
    if (!data) {
        updateStatus(node, "❌ 扫描失败（看 F12 控制台 + ComfyUI 黑窗口日志）");
        return false;
    }
    if (data.error) { updateStatus(node, `❌ 后端错误: ${data.error}`); return false; }
    if (!data.exists) { updateStatus(node, `❌ 目录不存在: ${data.directory}`); return false; }
    if (data.count < 1) { updateStatus(node, `⚠️ 目录里没有图片`); return false; }

    const idx = getWidget(node, "current_index")?.value ?? 0;
    const step = getWidget(node, "step")?.value ?? 1;
    const loop = !!getWidget(node, "loop_when_done")?.value;

    // 在尾帧模式下：首帧 = 上一段视频最后一帧 (不从 idx 取)，尾帧 = directory[idx+step]
    let i2;
    if (loop) {
        i2 = (idx + step) % data.count;
    } else {
        if (idx + step > data.count - 1) {
            updateStatus(node, `✅ 已遍历完 ${data.count} 张目标关键帧`);
            return false;
        }
        i2 = idx + step;
    }
    const f2 = data.files[i2];

    const sep = data.resolved.includes("\\") ? "\\" : "/";
    const src2 = data.resolved.replace(/[/\\]+$/, "") + sep + f2;

    // 找两个 LoadImage
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

    const slot1 = getWidget(firstNode, "image")?.value;
    const slot2 = getWidget(lastNode, "image")?.value;
    if (!slot1 || !slot2) {
        updateStatus(node,
            `⚠️ 目标 LoadImage 还没上传任何图作占位。` +
            `请先在 LoadImage #${firstId} / #${lastId} 各自上传占位图。`
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

    // 1) 让后端去 output/ 抽尾帧 → 直接写到 input/<slot1>
    //    如果 opts.explicitVideoPath 给了，就直接用那段视频；否则按 sinceTs 自动选最新匹配
    const sinceTs = node._sessionStartTime || 0;
    const explicitPath = opts.explicitVideoPath || "";
    const tailRes = await extractTailFrameToSlot(node, slot1, sinceTs, explicitPath);
    if (!tailRes.ok) {
        updateStatus(node, `❌ 尾帧抽取失败: ${tailRes.error}`);
        console.warn("[AutoSeq Ctrl] 尾帧抽取失败，候选视频:", tailRes.candidates);
        return false;
    }

    // 2) 把目录里下一张目标关键帧覆盖到 slot2
    const r2 = await injectFile(src2, slot2);
    if (!r2.ok) { updateStatus(node, `❌ 覆盖目标关键帧失败: ${r2.error}`); return false; }

    // 3) 刷新两个 LoadImage 的预览图（不改它们的位置/尺寸）
    refreshLoadImagePreview(firstNode);
    refreshLoadImagePreview(lastNode);

    const totalPairs = Math.max(0, data.count - step);
    const videoBase = (tailRes.video_path || "").split(/[\/\\]/).pop() || "?";
    const sourceTag = explicitPath ? "指定" : (tailRes.mode === "explicit" ? "指定" : "扫盘");
    updateStatus(node,
        `✅ 尾帧模式[${sourceTag}]: [${videoBase} 末帧 → 槽位 ${slot1}]  &  ` +
        `[${f2} → 槽位 ${slot2}]   进度 ${idx}/${totalPairs}  ` +
        `(${tailRes.video_resolution})`
    );
    return true;
}

// 根据 tail_frame_mode 开关决定走哪个分支
async function applyForCurrentMode(node, opts = {}) {
    const tailMode = !!getWidget(node, "tail_frame_mode")?.value;
    if (tailMode && !opts.forceFromDirectory) {
        return applyTailPair(node, opts);
    }
    return applyCurrentPair(node);
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
                // 手动按这里 = 强制按目录顺序应用（即使在尾帧模式下，也是从 directory 取首帧）
                // 这是初始化链条用的，第一段视频还没生成时只能这样起步
                await applyCurrentPair(this);
            });

            this.addWidget("button", "🔁 应用尾帧对（用上一段视频末帧作首帧）", null, async () => {
                // 手动触发尾帧模式应用：找最新的匹配视频，抽末帧 → 首帧槽位
                // 适合：① 调试尾帧模式 ② 中途从已有视频继续接力
                if (!this._sessionStartTime) {
                    // 没记录过 session 开始时间，让用户决定是否考虑历史所有视频
                    if (!confirm("还没有本次会话的执行记录。\n是否扫描 output/ 里的所有历史视频?\n(点取消放弃；点确定将考虑所有历史视频。)")) {
                        return;
                    }
                }
                await applyTailPair(this);
            });

            this.addWidget("button", "🎞 选视频抽尾帧（手动指定）", null, async () => {
                // 弹出本会话已登记视频列表，选一个就用它的尾帧覆盖到首帧槽位
                // 尾帧槽位仍按目录里的下一张目标关键帧覆盖
                const videoPath = await pickVideoDialog(this, "选一段视频抽尾帧 → 覆盖到首帧槽位");
                if (!videoPath) return;
                const tailMode = !!getWidget(this, "tail_frame_mode")?.value;
                if (!tailMode) {
                    if (!confirm("当前没开 tail_frame_mode。\n继续会临时按尾帧模式应用一次（首帧 = 选中视频末帧），但 index 不会推进。\n确定?")) return;
                }
                await applyTailPair(this, { explicitVideoPath: videoPath });
            });

            this.addWidget("button", "⬅ 上一对（回退一段视频）", null, async () => {
                // 沿着视频链回退一格：
                //   1) current_index -= step
                //   2) 把队列尾的「当前段视频」弹掉（这段不要了）
                //   3) 尾帧模式下：用「现在的队列末尾」(原来的倒数第二段) 作首帧；
                //      正常模式下：directory[new_idx] 作首帧
                const cur = getWidget(this, "current_index")?.value ?? 0;
                const step = getWidget(this, "step")?.value ?? 1;
                if (cur < step) {
                    updateStatus(this, "⚠️ 已经在起点，无法再回退");
                    return;
                }
                const newIdx = cur - step;
                setWidgetValue(this, "current_index", newIdx);

                // 队列里弹掉当前段（这段我们不满意，要重做）
                const popped = await popLastVideo(this);
                if (popped.ok && popped.popped) {
                    console.log(`[AutoSeq Ctrl] 弹出当前段: ${popped.popped.video_basename}, 队列剩 ${popped.queue_length}`);
                }

                const tailMode = !!getWidget(this, "tail_frame_mode")?.value;
                if (!tailMode) {
                    // 目录模式：直接按目录取
                    await applyCurrentPair(this);
                    return;
                }

                // 尾帧模式：用「现在的队列末尾」(也就是回退后的「上一段视频」) 抽尾帧
                const list = await listVideos(this);
                if (list.ok && list.videos && list.videos.length > 0) {
                    const prev = list.videos[list.videos.length - 1];
                    if (prev.exists) {
                        await applyTailPair(this, { explicitVideoPath: prev.video_path });
                        return;
                    }
                    updateStatus(this, `⚠️ 上一段视频已被删除: ${prev.video_basename}`);
                }
                // 队列空了 (回退到链条起点) → 退化成目录模式起步
                updateStatus(this, "ℹ️ 已回退到起点，从目录取首帧");
                await applyCurrentPair(this);
            });

            this.addWidget("button", "📜 查看视频历史", null, async () => {
                const r = await listVideos(this);
                if (!r.ok) { alert("读取失败: " + (r.error || "?")); return; }
                if (!r.videos || r.videos.length === 0) {
                    alert("本会话还没登记过视频。");
                    return;
                }
                const lines = r.videos.map((v, i) => {
                    const seg = (v.segment_index !== undefined && v.segment_index !== null) ? `#${v.segment_index}` : "?";
                    const time = _formatTime(v.mtime);
                    const ex = v.exists ? "✅" : "🚫";
                    return `${ex} [${i+1}] ${seg}  ${v.video_basename || "?"}  ${v.resolution || ""}  ${time}`;
                });
                alert(`本会话已登记 ${r.videos.length} 段视频:\n\n` + lines.join("\n"));
            });

            this.addWidget("button", "🗑 清空视频历史", null, async () => {
                if (!confirm("确定清空本节点已登记的所有视频历史？\n（不会删磁盘上的视频文件，只清空插件的记录）")) return;
                const r = await clearHistory(this);
                if (r.ok) {
                    updateStatus(this, "🗑 视频历史已清空");
                } else {
                    alert("清空失败: " + (r.error || "?"));
                }
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
                // 重置 = 让链条重新起步 → 强制走目录模式
                this._sessionStartTime = 0;
                applyCurrentPair(this);
            });

            this.addWidget("button", "▶ 立即开始（应用 + 队列一次）", null, async () => {
                // 手动开始 = 从目录顺序起步（首帧来自 directory[idx]）
                // 后续接力时，如果开了 tail_frame_mode，自动切到尾帧模式
                const ok = await applyCurrentPair(this);
                if (ok) setTimeout(() => app.queuePrompt(0, 1), 250);
            });

            this.addWidget("button", "⏭ 跳过当前对（+step）", null, async () => {
                // 跳过 = 不重新跑当前这段，直接推进。
                // 尾帧模式下：跳过后下一段的首帧 = 最近一段已生成视频的末帧（队列末尾）
                //              目录模式下：直接 directory[new_idx] 作首帧
                const cur = getWidget(this, "current_index")?.value ?? 0;
                const step = getWidget(this, "step")?.value ?? 1;
                setWidgetValue(this, "current_index", cur + step);

                const tailMode = !!getWidget(this, "tail_frame_mode")?.value;
                if (!tailMode) {
                    await applyCurrentPair(this);
                    return;
                }
                // 尾帧模式：拿队列里最新一段视频抽尾帧
                const list = await listVideos(this);
                if (list.ok && list.videos && list.videos.length > 0) {
                    const last = list.videos[list.videos.length - 1];
                    if (last.exists) {
                        await applyTailPair(this, { explicitVideoPath: last.video_path });
                        return;
                    }
                }
                // 队列空 / 视频被删 → 兜底走自动扫盘
                await applyTailPair(this);
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
        api.addEventListener("execution_start", () => {
            executedThisRun.clear();
            // 标记每个 Controller 节点本次执行的开始时间，
            // 之后提取尾帧时只看这之后写入的视频，避免找到老视频
            const now = Date.now() / 1000; // unix seconds
            for (const node of (app.graph?._nodes || [])) {
                if (node.type === NODE_TYPE) {
                    // 减 2 秒缓冲，应付 mtime 精度差 / 时钟轻微不同步
                    node._sessionStartTime = now - 2;
                    // 记录这次跑用的是哪一对图（来自当前 idx），事后登记进队列
                    const idx = getWidget(node, "current_index")?.value ?? 0;
                    const step = getWidget(node, "step")?.value ?? 1;
                    node._lastRunIdx = idx;
                    node._lastRunStep = step;
                }
            }
        });
        api.addEventListener("executing", ({ detail }) => {
            if (detail !== null && detail !== undefined) executedThisRun.add(String(detail));
        });

        api.addEventListener("execution_success", async () => {
            const myNodes = (app.graph?._nodes || []).filter(n => n.type === NODE_TYPE);
            for (const node of myNodes) {
                if (!executedThisRun.has(String(node.id))) continue;

                const tailMode = !!getWidget(node, "tail_frame_mode")?.value;

                // ★ 第一步：登记刚刚生成的视频到本节点的视频队列。
                //   这样后续 ⬅ 上一对 / ⏭ 跳过 / 🎞 选视频抽尾帧都能用上。
                try {
                    // 拿这次跑用的首帧/尾帧文件名 (供历史里看是哪一对图)
                    const scan = await scanFor(node);
                    let firstFn = "", lastFn = "";
                    if (scan && scan.exists && scan.files && scan.files.length > 0) {
                        const idx = node._lastRunIdx ?? 0;
                        const step = node._lastRunStep ?? 1;
                        const i1 = idx % scan.count;
                        const i2 = (idx + step) % scan.count;
                        firstFn = scan.files[i1] || "";
                        lastFn = scan.files[i2] || "";
                    }
                    const reg = await registerLastVideo(node, node._lastRunIdx, firstFn, lastFn);
                    if (reg.ok) {
                        console.log(
                            `[AutoSeq Ctrl] 登记视频 ✓ #${reg.registered?.segment_index} ` +
                            `${reg.registered?.video_basename}  队列长度=${reg.queue_length}`
                        );
                    } else {
                        console.warn(`[AutoSeq Ctrl] 登记视频失败 (不影响后续): ${reg.error}`);
                    }
                } catch (e) {
                    console.warn("[AutoSeq Ctrl] register_video 异常:", e);
                }

                if (!getWidget(node, "auto_advance")?.value) {
                    // 不自动推进 index，但仍按当前模式刷新一下显示
                    if (tailMode) await applyTailPair(node);
                    else await applyCurrentPair(node);
                    continue;
                }

                const cur = getWidget(node, "current_index")?.value ?? 0;
                const step = getWidget(node, "step")?.value ?? 1;
                const newIdx = cur + step;
                setWidgetValue(node, "current_index", newIdx);
                console.log(
                    `[AutoSeq Ctrl] node #${node.id} 推进 → ${newIdx}  ` +
                    `(${tailMode ? "尾帧模式" : "目录模式"})`
                );

                // 关键：execution_success 之后是「下一段」的准备阶段，
                // 此时如果开了尾帧模式，就用刚生成视频的最后一帧作首帧
                const ok = tailMode
                    ? await applyTailPair(node)
                    : await applyCurrentPair(node);
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
