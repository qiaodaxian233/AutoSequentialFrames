# 🎬 ComfyUI-AutoSequentialFrames

把目录里的图片自动接力跑成连续视频链，搭配 **Wan2.2 / Hunyuan / Cog 等首尾帧视频模型** 使用：

```
(img1, img2) → (img2, img3) → (img3, img4) → ...
```

## 核心机制：**覆盖式上传** —— 不动你的工作流，不改 LoadImage 节点

LoadImage 节点的 `image` widget 值（也就是文件名）**永远不会被改动**。
工作流 JSON 文件每次保存都是干净的。

每次循环本插件做的事：
1. 读 LoadImage #97 的 widget 当前值（比如 `"00115-1.jpg"`），作为"槽位 1"
2. 读 LoadImage #184 的 widget 当前值（比如 `"00118-1.jpg"`），作为"槽位 2"
3. 把目录里第 N 张图的**文件内容**用 `shutil.copyfile` 覆盖到 `input/00115-1.jpg`
4. 把第 N+1 张图的内容覆盖到 `input/00118-1.jpg`
5. 触发 `queuePrompt`

ComfyUI 的 `LoadImage.IS_CHANGED` 是基于文件 SHA256 的 —— 文件内容一变，
ComfyUI 自动检测到并重新执行 LoadImage。完全无感切换。

---

## 安装

把整个 `ComfyUI-AutoSequentialFrames` 文件夹丢进
`D:\ComfyUI-aki-v1.7\ComfyUI\custom_nodes\`，**完全重启 ComfyUI**。

控制台看到 `[ComfyUI-AutoSequentialFrames] 已加载 🎬 首尾帧自动队列插件` 就成功。

---

## 使用步骤（推荐用 🎯 Controller 节点）

### ① 在两个 LoadImage 上**手动上传任意占位图**

这一步很关键 —— 占位图的**文件名**就是后面要被覆盖的"槽位"。

举例：
- 在 LoadImage **#97** 上点 "choose file to upload"，随便上传一张图，假设它的 widget 值变成 `"00115-1.jpg"`
- 在 LoadImage **#184** 上同样上传一张图，widget 值变成 `"00118-1.jpg"`
- ⚠️ **两个 LoadImage 的占位图文件名必须不同**，否则覆盖会互相干扰

### ② 加上 🎯 Controller 节点

双击空白画布 → 搜 `Auto Sequential` → 加 **🎯 Auto Sequential Controller (按 ID 遥控 LoadImage)**。

不需要接任何线。

### ③ 配置 Controller

| 顺序 | 操作 |
|---|---|
| `directory` | 填你的图片目录（绝对路径，如 `D:\AI\frames` 或 `G:\AI\frames` 都行） |
| 📋 选首帧 | 弹窗里点 `#97 LoadImage  〈 00115-1.jpg 〉` |
| 📋 选尾帧 | 点 `#184 LoadImage  〈 00118-1.jpg 〉` |
| 🔄 应用当前 index | 立即把 directory 中第 0、1 张图覆盖到两个槽位 → LoadImage 预览图变成实际首尾帧 |
| ▶ 立即开始 | 启动连续生成 |

### ④ 它自己跑

每生成完一段视频，自动：
- `current_index += step`
- 把目录里下一对图覆盖到那两个槽位文件
- LoadImage 预览同步刷新
- 自动队列下一次

`current_index` 在节点上能看到，跑到末尾会自动停止（除非勾上 `loop_when_done`）。

---

## 为什么这是 "不改原节点"？

- ✅ LoadImage 的 widget 值（`00115-1.jpg`、`00118-1.jpg`）从头到尾不变
- ✅ 工作流 JSON 文件保存出来还是原样，git diff 干净
- ✅ 不需要改子图、不需要重连任何线
- ✅ 你随时关掉 Controller 节点（设为 Bypass 或删掉），LoadImage 还是用最后一次覆盖的内容正常工作
- ✅ 跟你之前用上传按钮的体验一致 —— 因为机制就是模拟"用同一个文件名重新上传"

---

## 节点参数

### Controller 节点

| 参数 | 说明 |
|---|---|
| `directory` | 图片所在目录的**绝对路径**。可以在任意位置（不需要在 input/ 内） |
| `pattern` | 文件匹配模式，多个用 `;` 分隔。默认 `*.jpg;*.jpeg;*.png;*.webp;*.bmp` |
| `sort_method` | `natural`（推荐，`img2 < img10`）/ `alphabetical` / `modified_time` |
| `first_node_id` | 首帧 LoadImage 节点 ID（点 📋 自动填） |
| `last_node_id` | 尾帧 LoadImage 节点 ID |
| `current_index` | 当前用作首帧的图片索引（每次跑完自动 +step） |
| `step` | 首帧到尾帧的间隔。默认 1（相邻两张） |
| `loop_when_done` | 到末尾后是否回到开头继续 |
| `auto_advance` | 跑完后是否自动 `current_index += step` |
| `auto_queue` | 是否自动 `queuePrompt` 触发下一次 |

### 节点上的按钮

- **📋 选择首/尾帧 LoadImage (按 ID)** — 弹窗列出画布上所有 LoadImage（含 subgraph 内）
- **🔄 应用当前 index（覆盖到 LoadImage）** — 扫描 + 覆盖文件 + 刷新预览
- **🔗 (可选) 把目录链接进 input/** — 如果你想让 directory 也在 input/ 里出现一个软链接（一般不需要）
- **⏮ 重置 current_index 为 0**
- **▶ 立即开始** — 应用 + queuePrompt
- **⏭ 跳过当前对（仅 +step）**

底部 **状态** 行实时显示进度：
`✅ frame_005.jpg → 槽位[00115-1.jpg]  &  frame_006.jpg → 槽位[00118-1.jpg]   进度 5/116`

---

## 怎么把它接进你那个 Wan2.2 工作流

工作流外层已有：
- **id = 97** 首帧 LoadImage（widget = `00115-1.jpg`）
- **id = 184** 尾帧 LoadImage（widget = `00118-1.jpg`）

**完全不改原结构，4 步**：

1. 加 🎯 Controller 节点
2. `directory` 填 `D:\AI\frames`（你的图片目录绝对路径）
3. 📋 选首帧 → `#97`；📋 选尾帧 → `#184`
4. 点 ▶ 立即开始

之后它接力跑，LoadImage 97 / 184 的 widget 值始终是 `00115-1.jpg` / `00118-1.jpg`，但每次循环加载的实际图片是不同的。

---

## 另一个节点：🎬 Auto Sequential Image Pair

如果你**不在乎改工作流结构**，可以用这个 IMAGE 输出节点替代两个 LoadImage：

- 把 `first_frame` / `last_frame` 输出当 IMAGE 接到 `WanFirstLastFrameToVideo`
- 自动队列机制跟 Controller 一样
- 优点：自包含
- 缺点：要改原工作流接线、看不到 LoadImage 的预览

---

## 重要提醒

**只点一次 ▶，让它自己接力跑。** 不要手动连点 Queue —— ComfyUI 排队时按当前 widget 值序列化，连点 5 次会让那 5 个任务都用同一对图。

跑出错或点 Cancel 后链条会停下，`current_index` 已记住进度，修好再点 ▶ 即可继续。

---

## 调试

F12 浏览器控制台看 `[AutoSeq Ctrl]` 开头的日志：
```
[AutoSeq Ctrl] node #200 推进 → 5
[AutoSeq Ctrl] 自动队列下一次 (idx=5)
```

任何问题状态行会直接告诉你：
- `❌ 后端错误: <异常>` → 看 ComfyUI 黑窗口的 traceback
- `⚠️ 目标 LoadImage 还没上传任何图作占位` → 先去 LoadImage 上传一张占位图
- `⚠️ 两个 LoadImage 的占位文件名重复` → 给它们传不同文件名的图
- `❌ 找不到 LoadImage #X` → 重新点 📋 选一下
