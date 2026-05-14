# 项目对接记忆 — AutoSequentialFrames（Project Handoff Memory）

> **给下一个 Claude（或未来的我）**:这个文件是 AutoSequentialFrames 项目的状态快照。
> 用户 qiaodaxian233 换对话时,把这个文件丢给你就能直接接着干。
> **第一件事**:读完这份文件再动代码。

---

## 👤 用户信息

- **GitHub**:[qiaodaxian233](https://github.com/qiaodaxian233)
- **仓库**:<https://github.com/qiaodaxian233/AutoSequentialFrames>
- **默认分支**:`main`(注意:跟 truth-dare-wheel 用 `master` 不一样)
- **本地路径**:`D:\ComfyUI-aki-v1.7\ComfyUI\custom_nodes\AutoSequentialFrames`
- **运行环境**:ComfyUI-aki-v1.7(秋叶整合包)
- **沟通语言**:中文,直接动手 + 简短结论
- **更新方式偏好**:`git pull` + 重启 ComfyUI + Ctrl+F5 浏览器强刷
- **推送方式**:用户给 PAT,Claude 走 git push(白名单允许 github.com,**可推**,别说推不了)

---

## 🎯 项目是什么

**ComfyUI 自定义节点插件**,核心功能:**自动接力生成视频链** — 首尾帧视频生成模型一次只能输出一段视频,这个插件让一段视频生成完后,自动用它的**最后一帧**作为下一段的**首帧**,从而能把 N 段视频无缝接成长视频。

两个节点:
1. **🎬 AutoSequentialImagePair** — 老节点,直接替换 LoadImage,输出当前的 `(img[N], img[N+1])` 对。
2. **🎯 AutoSequentialController** — **主力节点**,不替换 LoadImage 而是**遥控**它们,用 `shutil.copyfile` 覆盖 input/ 下的占位图,从而 LoadImage 的 SHA256 IS_CHANGED 触发它重新加载。**工作流 JSON 完全不被修改**。

**用户的典型工作流**:Wan2.2 类首尾帧视频生成模型,一次输出 1920×1088 或 1088×1920 或 544×960 等分辨率的视频,要求段与段画面无缝衔接。

---

## 📂 项目结构(v1.4.0 / v7 — 当前状态)

```
AutoSequentialFrames/
├── auto_sequential.py              ← 后端,~1840 行,所有逻辑 + REST 接口
├── __init__.py                     ← 入口,导出 NODE_CLASS_MAPPINGS
├── pyproject.toml                  ← comfy registry 元数据
├── LICENSE
├── README.md                       ← 用户文档(已含 v7 多分辨率白名单 + 提示词手册章节)
├── VERSION.txt                     ← 版本号 + changelog(每次发版必更新)
└── web/
    ├── auto_sequential.js          ← AutoSequentialImagePair 的前端(老节点,~220 行)
    └── auto_sequential_controller.js  ← AutoSequentialController 的前端(主力,~1280 行)
```

**运行时持久化文件**(不在仓库里,由 ComfyUI 用户目录管理):
- `ComfyUI/user/auto_sequential_history.json` — 视频历史队列(按 controller_id 分组)
- `ComfyUI/user/auto_sequential_prompts.json` — 提示词手册(v7+,全局共享不分组)

如果取不到 user 目录,会回退到插件目录下的 `.auto_sequential_history.json` / `.auto_sequential_prompts.json`(隐藏文件)。

---

## 🏗️ 架构关键点(不要打破)

### 1. 「覆盖式上传」是核心机制(v3 之后所有版本基石)

用户在 LoadImage 上手动上传一张占位图(比如 `00115-1.jpg`),这个文件名是「槽位」。每次切换图片时,后端调 `/auto_sequential/inject` 把源文件 `shutil.copyfile` 覆盖到 `input/00115-1.jpg`。LoadImage 的 widget 值丝毫不变,但 ComfyUI 的 LoadImage 用 SHA256 判断是否需要重新加载,文件内容一变它就会重新跑。**工作流 JSON 永远干净**。

不要尝试改 LoadImage 的 widget 值 —— 那会导致工作流 dirty。

### 2. 双前端文件,两个节点分开注册

`web/auto_sequential.js` 和 `web/auto_sequential_controller.js` 各自 `app.registerExtension`。改一个不会影响另一个,但**两个文件都用了同一组 helper(getWidget / setWidget)**,各自实现各自的 —— 不要试图抽公共模块,ComfyUI 前端的 import 体系不友好,容易翻车。

### 3. controller_id 隔离视频历史,prompts 不隔离

历史队列按 `controller_id`(也就是节点的 `String(node.id)`)分组,这样画布上多个 Controller 节点各跑各的,互不干扰。

提示词手册**故意不按 controller_id 分组** —— 用户希望 prompt 在多个工作流之间共享,搬来搬去都能看到同一本本子。

### 4. 多分辨率白名单(v7 核心)— 前后端解析必须对齐

`_parse_resolution_list` 用**正则** `(\d+)\s*[x*×]\s*(\d+)` 直接抓所有 `数字×数字` 模式,**不靠分隔符切分**。这样支持:
- `;` `,` 空格 换行 任意分隔
- 大小写 X / × / *
- 嵌中文也能抓干净(`"分辨率: 1920x1088 和 1088x1920"`)
- 去重 + 顺序保留

**Python 实现**:`auto_sequential.py` 的 `_parse_resolution_list(s)`
**JS 实现**:`auto_sequential_controller.js` 的 `parseResolutionList(s)`

**两边逻辑必须保持一致**。改一边记得对应改另一边。已有 14 个 case 单测,改完跑一遍。

特殊值:`""` / `"*"` / `"any"` / `"auto"` / `"all"` → `[]`(任意分辨率,不过滤)。

### 5. 后端接口字段双兼容(向后兼容关键)

`register_video` 和 `extract_tail_frame(方式B)` 同时接受:
- **新字段** `target_resolutions`(list 或字符串)— 多分辨率白名单
- **老字段** `target_width` + `target_height` — 单一分辨率

代码里 `if "target_resolutions" in data` 优先用新字段,else 回退到老字段。**改这两个接口时,这个双兼容逻辑别动**,否则用户老工作流会崩。

### 6. register_only_target_res 是「兜底关阀」

用户随时可以在节点上把这个 widget 关掉 → 后端 `register_video` 直接取 `since_timestamp` 之后最新视频,完全忽略分辨率。这是「不管啥分辨率自动取最新」的官方做法,不要试图删它。

### 7. 尾帧抽取用 cv2,中文路径要 imencode 兜底

`_extract_video_last_frame` 用 `cv2.VideoCapture` + `cv2.imwrite`。Windows + 中文路径下 `cv2.imwrite` 会失败 → 代码里有 `cv2.imencode + 文件写入` 兜底。改这函数时别删兜底分支。

### 8. node._sessionStartTime 是「本次会话起点」

`execution_start` 事件里设 `node._sessionStartTime = Date.now()/1000 - 2`(减 2 秒应付 mtime 精度差)。后续 `register_video` 和 `extract_tail_frame` 用这个值作 `since_timestamp`,确保只看「本次启动之后」生成的视频,不会找到老的。

用户重置 current_index 时也会清零 `_sessionStartTime` → 链条彻底重新起步。

### 9. LoadImage 预览刷新要锁 node.size / node.pos

`refreshLoadImagePreview()` 触发 LoadImage 重新拉预览图后,LoadImage 会按新图宽高比重算 `node.size`,把画布布局挤歪。代码里用 `setTimeout` 多次 restore `node.size` / `node.pos`,挡掉 LoadImage 的自动 resize。改这个函数小心。

---

## ⚠️ 已知避坑

### A. 默认分支是 `main`,不是 `master`

跟 truth-dare-wheel 不一样。`git push origin main`,别按肌肉记忆敲 master。

### B. ComfyUI 前端用了浏览器缓存

改完 JS 用户必须 **Ctrl + F5** 强刷,否则看到的还是旧界面。每次让用户测之前先提醒一句。

### C. Python 后端改了必须重启 ComfyUI

ComfyUI 不像 Web 服务,Python 模块改了不会热重载。改完 `.py` 必须用户手动重启。

### D. 用户的 ComfyUI 是秋叶整合包(ComfyUI-aki-v1.7)

路径 `D:\ComfyUI-aki-v1.7\ComfyUI\`。output 默认在 `D:\ComfyUI-aki-v1.7\ComfyUI\output\`。

### E. opencv-python 是软依赖

`_extract_video_last_frame` 和 `_get_video_resolution` 都 import cv2。秋叶整合包自带,但写代码时仍然 try/except,失败时友好提示「需要 pip install opencv-python」。

### F. comfy registry 发布

`pyproject.toml` 里有 `[tool.comfy]` 段,理论上可以 publish 到 comfy registry。**目前没在 registry 上**(只走 GitHub),用户没要求发布。如果要发的话:`comfy node publish`,但本地需装 comfy CLI。

### G. 不要把 test_e2e.py 推进仓库

本地测试脚本,装了 mock server.PromptServer / folder_paths 跑 aiohttp 接口测试。每次 PAT 推送时只推 `auto_sequential.py` / `web/*.js` / `README.md` / `VERSION.txt`,**不推** test_e2e.py 和 __pycache__。

---

## 🔌 REST 接口完整清单(后端 v7)

所有路径前缀:`/auto_sequential/`

| 路径 | 方法 | 用途 |
|---|---|---|
| `scan` | POST | 扫描 directory,返回图片文件列表 + 预览 |
| `link` | POST | 在 input/ 下创建到 src 的软链接(Win 用 mklink /J) |
| `inject` | POST | 把 src 的内容覆盖到 input/dst(核心覆盖式上传) |
| `extract_tail_frame` | POST | 抽视频末帧 → 写到 input/dst。两种模式:① 指定 video_path ② 扫盘自动选(按 target_resolutions + since_timestamp) |
| `register_video` | POST | 登记本次生成的视频到 controller 历史队列。支持 target_resolutions 白名单 + only_target_res 开关 |
| `list_videos` | POST | 列出某 controller 的历史队列 |
| `pop_last_video` | POST | 弹出队列末尾(上一对回退用) |
| `clear_history` | POST | 清空某 controller 历史(或全部) |
| `list_dir_videos` | POST | 直接扫 output_dir 磁盘,**不依赖会话队列**,列出所有视频(带 in_queue 标记)。给🎞选视频抽尾帧弹窗用 |
| `prompts/list` | POST | **v7+** 列出提示词手册,可按 search / tag 过滤 |
| `prompts/save` | POST | **v7+** 新增或更新提示词(id 为空 = 新增) |
| `prompts/delete` | POST | **v7+** 删除一条(传 id)或清空全部(传 all:true) |

---

## 🔄 PAT 推送工作流

每次用户给 PAT 时,**严格按这个流程**:

```bash
# 1. 临时目录 clone(PAT 只在 URL 里,不进 git config)
mkdir -p /tmp/push_work && cd /tmp/push_work && rm -rf AutoSequentialFrames
PAT="github_pat_xxx"
git clone "https://x-access-token:${PAT}@github.com/qiaodaxian233/AutoSequentialFrames.git" 2>&1 | sed 's/[A-Za-z0-9_]\{40,\}/<REDACTED>/g'

# 2. 拷贝改动的文件
cd AutoSequentialFrames
cp /home/claude/work/auto_sequential.py                      ./auto_sequential.py
cp /home/claude/work/web/auto_sequential_controller.js       ./web/auto_sequential_controller.js
cp /home/claude/work/web/auto_sequential.js                  ./web/auto_sequential.js   # 改了才拷
cp /home/claude/work/README.md                               ./README.md
cp /home/claude/work/VERSION.txt                             ./VERSION.txt
# ⚠️ test_e2e.py 和 __pycache__ 不要拷

# 3. 配置 git
git config user.name "qiaodaxian233"
git config user.email "qiaodaxian233@users.noreply.github.com"

# 4. commit + push(commit message 中文,描述清楚做了啥)
git add -A
git commit -m "vX.Y.Z: 一句话标题

- 改动点 1
- 改动点 2
- 修复的根因(如果有)"

git push origin main 2>&1 | sed 's/[A-Za-z0-9_]\{40,\}/<REDACTED>/g'
```

**关键点**:
- 默认分支 `main`,不是 master
- log 输出过滤 PAT(用 sed 过滤 40 位以上的连续字母数字)
- `git status` 确认就是 4 个改动,没有多余文件
- 推完查 `git log --oneline -3` 二次确认

---

## 📜 版本历史

### v1.4.0 / v7-multi-resolution-and-prompt-book(2026-05-14)— 多分辨率白名单 + 提示词手册

commit `b63923c`。**本次对话产出**。

**改动**:
1. **target_resolution 升级为白名单**
   - 默认 `1920x1088;1088x1920;544x960;960x544`(覆盖横/竖屏 × 高/低分辨率)
   - 留空 / `*` / `auto` / `any` = 不过滤(任意分辨率取最新视频)
   - 前后端 `_parse_resolution_list` 正则解析对齐,14 case 单测全过
   - 新字段 `target_resolutions`(list 或字符串),老字段 `target_width/height` 仍兼容
2. **节点新增按钮 📐 编辑目标分辨率(白名单)**
   - chip 增删 UI,9 个常用预设(1920×1088 / 1088×1920 / 544×960 / 960×544 / 1280×720 / 720×1280 / 1024×1024 / 832×480 / 480×832)
   - 「清空 = 任意分辨率」一键关掉过滤
3. **节点新增按钮 📖 提示词手册**
   - 左列表 + 右编辑表单,支持新增/更新/删除/复制/搜索/标签
   - 持久化到 `ComfyUI/user/auto_sequential_prompts.json`,全局共享不分组
   - 后端新增 3 接口:`prompts/list` `prompts/save` `prompts/delete`
4. **修复根因**:原版只识别 1920x1088 是因为 register_video 写死 target_width/height,命中不上就 `skipped_reason=no_target_res_match` 跳过,自动接力链断掉。改成白名单后,544x960 / 960x544 / 1088x1920 都能被自动登记。

**改动文件**(4 个):
- `auto_sequential.py`(+700 / -50)
- `web/auto_sequential_controller.js`(+370 / -35)
- `README.md`(更新参数表 + 新增两个章节)
- `VERSION.txt`(新版本号 + 变更说明)

### v1.3.0 / v6-disk-scan-and-resfilter(2026-05-02)

- 后端 `/auto_sequential/list_dir_videos` 接口
- `register_video` 加 `only_target_res` 参数
- 节点 widget `register_only_target_res`
- 前端 🎞 按钮改为扫磁盘列视频

### v1.2.0 / v5-history-and-rewind(2026-05-02)

- 视频历史持久化(`~/user/auto_sequential_history.json`)
- 4 个接口:`register` / `list` / `pop_last` / `clear`
- `extract_tail_frame` 加 `video_path` 参数
- 按钮:⬅ 上一对 / 🎞 选视频抽尾帧 / 📜 视频历史 / 🗑 清空历史

### v1.1.0 / v4-tail-frame-mode(2026-05-01)

- 尾帧模式(`tail_frame_mode`)
- Controller 节点新增 3 个 widget
- 后端 `/auto_sequential/extract_tail_frame`(cv2 抽帧)

### v3-overlay-mode(2026-05-01)

- **核心机制**:覆盖式上传(不改 LoadImage 的 widget 值)
- 后端 `/auto_sequential/inject`(shutil.copyfile)

---

## 🚦 用户偏好(Communication Style)

- **直接给方案,不要长篇大论**。一上来先动手,结论放最后
- **被质疑能力时坦诚承认**比辩解好(用户给 PAT 时**绝对不要**说"我没法用、我没联网",沙箱白名单里就有 github.com,PAT 推送完全可行)
- 喜欢**对比表格**和**进度清单**
- 测试时**只发结果截图**,让你解读
- 提的功能要**一次性全做完**,别漏
- 部署用 `git pull`,**不喜欢下载 zip 复制粘贴**
- 用户碰到下载链接挂掉的问题,**直接走 PAT git push 路线**,别推荐"换浏览器/手机/SSH"等方案
- 如果同一个 PAT 被发了两次但没新改动要推,先确认远端状态,然后顺手做点延伸工作(比如更新这份记忆文件)

---

## ⚠️ 下一个 Claude 行动检查清单

**当用户问"我们之前是不是做过 XX"或者"有没有类似的"时,先在沙箱里查本地代码状态,再回答。**

```bash
# 1. 看本地 work 目录有没有半成品
ls /home/claude/ 2>/dev/null
find /home/claude -maxdepth 3 -iname "*AutoSequential*" 2>/dev/null

# 2. clone 远端核对
mkdir -p /tmp/check && cd /tmp/check && rm -rf AutoSequentialFrames
git clone --depth 1 https://github.com/qiaodaxian233/AutoSequentialFrames.git 2>&1 | tail -2
cat /tmp/check/AutoSequentialFrames/VERSION.txt | head -3

# 3. 然后再回答用户
```

**别**只搜聊天记录就说"没做过" —— 那搜不到沙箱代码遗留和远端最新状态。

---

## 🔮 还可以做的方向(用户问起再做)

1. **提示词手册导入导出** —— 当前只能本地建,加 export JSON / import JSON 方便多机同步
2. **提示词手册分组(category)** —— 当前只有 tag,可以加 category 做层级
3. **多分辨率自动检测** —— 用户填了 directory 后,自动扫一遍 output 推断最常见的分辨率自动填进 widget
4. **批量重命名 / 批量删除视频** —— 长链跑久了 output 一堆,加个清理工具
5. **首尾帧颜色匹配** —— 用 PIL 检测 V_N 末帧和 V_{N+1} 首帧的颜色直方图差异,提醒用户某段衔接可能不平滑
6. **comfy registry 发布** —— 让用户搜得到

---

## 📝 此文件维护

下一次 Claude 做了重大改动,请:

1. 更新 VERSION.txt(版本号 + 日期)
2. 在「版本历史」加一条
3. 更新「项目结构」段反映新文件
4. **推送本文件到 GitHub 仓库根目录**(让记忆持续)

文件路径:`项目对接记忆_AutoSeq.md`(仓库根目录,跟 README.md 同级)

---

*最后更新:v1.4.0 / v7(多分辨率白名单 + 提示词手册)*
*由 Claude(claude-opus-4-7)与 qiaodaxian233 协作生成*
