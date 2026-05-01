// ComfyUI-AutoSequentialFrames / web / auto_sequential.js
//
// 前端逻辑：
//   1) 给 🎬 Auto Sequential Image Pair 节点加几个按钮（扫描 / 重置 / 立即开始 / 跳过）
//   2) 监听 ComfyUI 的 execution_success 事件
//        - 若该节点确实参与了本次执行 → current_index += step
//        - 若 auto_queue 开启且未到末尾 → 自动 app.queuePrompt 触发下一次
//   3) 节点上有一个状态行，实时显示 "📂 N 张图片 | 进度 i/N"

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "AutoSequentialImagePair";
const ENDPOINT = "/auto_sequential/scan";

// 跟踪本次 prompt 中实际执行过的节点 id
const executedThisRun = new Set();

function getWidget(node, name) {
    return node.widgets?.find(w => w.name === name);
}

function setWidget(node, name, value) {
    const w = getWidget(node, name);
    if (!w) return false;
    w.value = value;
    if (typeof w.callback === "function") {
        try { w.callback(value); } catch (e) { /* ignore */ }
    }
    return true;
}

async function scanDirectory(node) {
    const dir = getWidget(node, "directory")?.value || "";
    const pat = getWidget(node, "pattern")?.value || "*.jpg;*.png";
    const sort = getWidget(node, "sort_method")?.value || "natural";
    if (!dir) return { count: 0, files: [], preview: [], exists: false, directory: "" };
    try {
        const res = await fetch(ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ directory: dir, pattern: pat, sort_method: sort }),
        });
        return await res.json();
    } catch (e) {
        console.error("[AutoSeq] scan failed:", e);
        return { count: 0, files: [], preview: [], exists: false, directory: dir };
    }
}

function updateStatus(node, text) {
    if (node._statusWidget) {
        node._statusWidget.value = text;
        node.setDirtyCanvas(true, true);
    }
}

async function refreshStatus(node) {
    const data = await scanDirectory(node);
    const idx = getWidget(node, "current_index")?.value ?? 0;
    const step = getWidget(node, "step")?.value ?? 1;

    if (!getWidget(node, "directory")?.value) {
        updateStatus(node, "（请填 directory，然后点 🔍 扫描）");
        return data;
    }
    if (data.error) {
        updateStatus(node, `❌ 后端错误: ${data.error}`);
        return data;
    }
    if (!data.exists) {
        updateStatus(node, `❌ 目录不存在: ${data.directory}`);
        return data;
    }
    if (data.count === 0) {
        updateStatus(node, `⚠️ 目录中没有匹配的图片（检查 pattern）`);
        return data;
    }
    if (data.count < 2) {
        updateStatus(node, `⚠️ 仅 ${data.count} 张图片，无法配成首尾帧`);
        return data;
    }

    const totalPairs = Math.max(0, data.count - step);
    const cur = Math.min(idx, totalPairs);
    const next1 = data.preview[cur] ?? "?";
    const next2 = data.preview[cur + step] ?? "?";
    updateStatus(
        node,
        `📂 ${data.count} 张 | 进度 ${cur + 1}/${totalPairs} | 即将: ${next1} → ${next2}`
    );
    return data;
}

app.registerExtension({
    name: "ComfyUI.AutoSequentialFrames",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated?.apply(this, arguments);

            // —— 按钮区 ——
            this.addWidget("button", "🔍 扫描目录 / 刷新状态", null, () => {
                refreshStatus(this);
            });

            this.addWidget("button", "⏮ 重置 current_index 为 0", null, () => {
                setWidget(this, "current_index", 0);
                refreshStatus(this);
            });

            this.addWidget("button", "▶ 立即开始（队列一次）", null, () => {
                app.queuePrompt(0, 1);
            });

            this.addWidget("button", "⏭ 跳过当前对（仅 +step，不出图）", null, () => {
                const cur = getWidget(this, "current_index")?.value ?? 0;
                const step = getWidget(this, "step")?.value ?? 1;
                setWidget(this, "current_index", cur + step);
                refreshStatus(this);
            });

            // —— 状态显示 ——
            this._statusWidget = this.addWidget(
                "text", "状态", "（点击 🔍 扫描）",
                () => {},
                { serialize: false }
            );

            // 节点刚加进来时，等 widgets 稳定再扫描一次
            setTimeout(() => refreshStatus(this), 250);

            return r;
        };

        // 从工作流加载时也刷新一次
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = onConfigure?.apply(this, arguments);
            setTimeout(() => refreshStatus(this), 350);
            return r;
        };
    },

    async setup() {
        // 每次新 prompt 开始时清空"已执行节点"集合
        api.addEventListener("execution_start", () => {
            executedThisRun.clear();
        });

        api.addEventListener("executing", ({ detail }) => {
            // detail = node id (string) 表示某节点开始执行；为 null 表示本 prompt 全部结束
            if (detail !== null && detail !== undefined) {
                executedThisRun.add(String(detail));
            }
        });

        api.addEventListener("execution_success", async () => {
            const myNodes = (app.graph?._nodes || []).filter(n => n.type === NODE_TYPE);
            if (!myNodes.length) return;

            for (const node of myNodes) {
                if (!executedThisRun.has(String(node.id))) {
                    // 没参与本次执行（可能被 Bypass 了），不动
                    continue;
                }

                const advance = !!getWidget(node, "auto_advance")?.value;
                const idxW = getWidget(node, "current_index");
                if (!advance || !idxW) {
                    await refreshStatus(node);
                    continue;
                }

                const step = getWidget(node, "step")?.value ?? 1;
                const newIdx = (idxW.value ?? 0) + step;
                setWidget(node, "current_index", newIdx);
                console.log(`[AutoSeq] node #${node.id} 推进 current_index → ${newIdx}`);

                const autoQueue = !!getWidget(node, "auto_queue")?.value;
                if (!autoQueue) {
                    await refreshStatus(node);
                    continue;
                }

                // 检查是否还有图可用
                const data = await scanDirectory(node);
                await refreshStatus(node);

                const looping = !!getWidget(node, "loop_when_done")?.value;
                const haveEnough = looping || (newIdx + step <= data.count - 1);

                if (!haveEnough) {
                    updateStatus(
                        node,
                        `✅ 已遍历完所有 ${data.count} 张图片，自动队列结束`
                    );
                    console.log("[AutoSeq] 到达末尾，自动队列停止");
                    continue;
                }

                // 稍微 delay 一下，让新的 widget 值被序列化进下一次 prompt
                setTimeout(() => {
                    app.queuePrompt(0, 1);
                    console.log(`[AutoSeq] 自动队列下一次 (current_index=${newIdx})`);
                }, 250);
            }
        });

        api.addEventListener("execution_error", () => {
            console.warn("[AutoSeq] 检测到执行错误，自动队列已停止");
        });
    },
});
