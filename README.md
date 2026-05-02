# 🎬 ComfyUI-AutoSequentialFrames

把目录里的图片自动接力跑成连续视频链，搭配 **Wan2.2 / Hunyuan / Cog 等首尾帧视频模型** 使用：

```
(img1, img2) → (img2, img3) → (img3, img4) → ...
```

或者开启 **尾帧模式 (tail_frame_mode)**，让上一段视频的最后一帧自动作为下一段视频的首帧，画面真正无缝接续：

```
(img1, img2) → 视频 V1
(V1 最后一帧, img3) → 视频 V2
(V2 最后一帧, img4) → 视频 V3
...
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
| `tail_frame_mode` | **🆕 尾帧模式**：开启后，每跑完一段视频自动抽出末帧作为下一段首帧 |
| `output_dir` | 输出视频目录（留空 = ComfyUI/output/，尾帧模式才用得到） |
| `target_resolution` | 目标视频分辨率，如 `1920x1088`，用来过滤掉中间预览/低分辨率视频 |

### 节点上的按钮

- **📋 选择首/尾帧 LoadImage (按 ID)** — 弹窗列出画布上所有 LoadImage（含 subgraph 内）
- **🔄 应用当前 index（覆盖到 LoadImage）** — 扫描 + 覆盖文件 + 刷新预览（始终从 directory 取，用于初始化）
- **🔁 应用尾帧对（用上一段视频末帧作首帧）** — 手动触发尾帧抽取，方便调试或从已有视频中途接力
- **🎞 选视频抽尾帧（手动指定）** — **🆕** 弹出本会话已生成的视频列表，点一个就用它的末帧作首帧。适合「这段重做但 V2 那段我满意，从 V2 接着往下走」。
- **⬅ 上一对（回退一段视频）** — **🆕** 当前段不满意时点这个：`current_index -= step` + 队列里弹掉当前段 + 用「队列里现在的最后一段」(回退后的上一段视频) 作首帧。再点一次就再回退一段，回退到链条起点会自动从目录起步。
- **📜 查看视频历史** — **🆕** 看本节点已登记的所有视频
- **🗑 清空视频历史** — **🆕** 清空插件记录 (不会删磁盘上的视频文件)
- **🔗 (可选) 把目录链接进 input/** — 如果你想让 directory 也在 input/ 里出现一个软链接（一般不需要）
- **⏮ 重置 current_index 为 0**
- **▶ 立即开始** — 应用 + queuePrompt
- **⏭ 跳过当前对（+step）** — **🆕** 尾帧模式下,跳过后下一段会用「队列里最近一段视频」的末帧作首帧 (旧行为是不管尾帧模式总是从目录取,会破坏链条接续)

底部 **状态** 行实时显示进度：
`✅ frame_005.jpg → 槽位[00115-1.jpg]  &  frame_006.jpg → 槽位[00118-1.jpg]   进度 5/116`

尾帧模式下状态行类似：
`✅ 尾帧模式[扫盘]: [VID_00012.mp4 末帧 → 槽位 00115-1.jpg]  &  [frame_006.jpg → 槽位 00118-1.jpg]   进度 5/116  (1920x1088)`
(`扫盘` 表示后端按 since_timestamp + 分辨率自动找最新视频；`指定` 表示这次用了显式指定的视频路径)

---

## 🆕 尾帧模式 (tail_frame_mode)

### 这是什么 / 为啥要有它

在 **正常模式** 下，每段视频的「首帧」直接来自目录里的图：第 N 段用 `img[N]`，第 N+1 段用 `img[N+1]`。
但首尾帧视频模型生成出来的视频，最后一帧不一定**完全等于**你给的 `img[N+1]` —— 它只是在朝那张图收敛。
连起来播放时，第 N 段的末尾画面 ≠ 第 N+1 段的开头画面，看着会有跳变/闪一下。

**尾帧模式** 解决这个问题：上一段视频生成完毕后，自动从 `output/` 找到这段视频，抽出**它实际的最后一帧**，
直接作为下一段视频的「首帧」，从而保证段与段之间画面真正连续。

```
正常模式:    (img[0], img[1]) → V1     (img[1], img[2]) → V2     (img[2], img[3]) → V3
                                       ↑ 注意首帧来自 directory
尾帧模式:    (img[0], img[1]) → V1     (V1末帧, img[2]) → V2     (V2末帧, img[3]) → V3
                                       ↑ 首帧来自 V1 的最后一帧
```

第一段视频还得靠 directory 起步（毕竟那时候还没有「上一段视频」），之后的接力全自动用上一段的尾帧。

### 为啥要 `target_resolution`

有些工作流一次会输出**两个视频**：一个低分辨率预览版（如 720p）+ 一个 1920×1088 的最终版。
如果不过滤分辨率，可能会抽到预览版的最后一帧 → 输入 LoadImage 时分辨率对不上 → 报错或生成出来变形。

`target_resolution` 默认填 `1920x1088`（也支持 `1920*1088`、`1920×1088` 写法），
插件只会从匹配这个分辨率的视频里抽末帧。其它工作流改这一项就行。

### 怎么用

1. 像之前一样配好 directory / 选好 LoadImage（参考上面的标准用法）
2. 把 **tail_frame_mode** 勾上 ✅
3. 确认 **target_resolution** = `1920x1088`（你的工作流如果输出别的分辨率改成对应值）
4. **output_dir** 留空就行（默认 = ComfyUI/output/），除非你重定向了输出
5. 点 ▶ 立即开始

> ⚠️ 第一段还是从 `directory[0] → directory[1]` 起步，这是正常的。从第二段开始才走尾帧。

### 依赖

尾帧模式用 **opencv-python** 抽帧。99% 的 ComfyUI 环境（含 ComfyUI-aki 整合包）已经自带。
如果控制台报 `需要 opencv-python` 错误：

```bash
# 在 ComfyUI 的 Python 环境里
python -m pip install opencv-python
```

### 调试 / 排查

- **`❌ 没在最近的视频里找到 1920x1088 分辨率的`** → 检查工作流实际输出的分辨率，把 `target_resolution` 改成对的
- **`❌ 在 ... 里没找到 since_timestamp=... 之后的视频文件`** → output_dir 写错了，或视频还没写完就 fire 了 execution_success（极少见）
- **首帧不对（取到了旧视频的）** → `current_index` 重置一下，再点 ▶ 立即开始，会重置 session 时间戳
- 想看候选视频列表：F12 控制台找 `[AutoSeq Ctrl] 尾帧抽取失败，候选视频:` 日志

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

---

## 🆕 视频历史 (v1.2.0+)

每次执行成功后,插件会扫描 output 目录找到刚生成的、分辨率匹配的视频,登记进**本节点**的视频队列。这个队列:

- **持久化**到 `ComfyUI/user/auto_sequential_history.json`,刷新页面或重启 ComfyUI 后还在
- **按节点 ID 隔离**:你画布上多个 Controller 节点各跑各的,互不干扰
- **同 path 去重 + 上限 200 条**:不会无限增长
- 通过 **🗑 清空视频历史** 按钮可一键清空 (只清记录,不删磁盘文件)

视频历史驱动这三个新功能:

| 按钮 | 用法 |
|---|---|
| **⬅ 上一对** | 当前段不满意 → 沿视频链回退一格,重新跑 |
| **🎞 选视频抽尾帧** | 手动选某段视频的末帧作首帧 (例如 V2 之后想跳过 V3 直接接 V4 的设定) |
| **⏭ 跳过当前对** | 尾帧模式下也能正确接续 (旧版会回退到目录图,破坏链条) |

### 排查

- 「⬅ 上一对」按了没反应 → 状态行会说原因。最常见的是:
  - 「已经在起点」:`current_index < step`,无法再往回
  - 「上一段视频已被删除」:对应文件被你手动删掉了,只能用 🎞 选视频抽尾帧 重新指定
- 「📜 查看视频历史」里有 🚫 标记的项 → 那段视频文件已不在磁盘 (被删了或换了路径)
- 想从一个干净状态开始 → 点 **🗑 清空视频历史** + **⏮ 重置 current_index 为 0**
