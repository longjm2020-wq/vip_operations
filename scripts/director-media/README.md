# Windows 导演台本机媒体引擎

基本的 FFmpeg 剪辑只需要桌面程序和 FFmpeg。下列适配器在执行电脑上选装。配置从 Windows 用户的 %LOCALAPPDATA%\XutiDesktop\director-media.json 读取，也可以用 XUTI_DIRECTOR_MEDIA_CONFIG 指向一个绝对路径。XUTI_DIRECTOR_PYTHON 指向含所需依赖的 python.exe。更改环境变量后重启桌面端。

配置仅由本机管理员维护。使用绝对路径，在该电脑有权使用的模板、权重和输入素材上运行。登记的 Lottie 模板使用内嵌素材或显式替换的图片。项目参数仅包含模板 ID、文字、图片和时长。

~~~json
{
  "ffmpeg": "D:/Media/ffmpeg/bin/ffmpeg.exe",
  "node": "C:/Program Files/nodejs/node.exe",
  "chromium": "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "motionModules": "D:/Media/motion/node_modules",
  "autoSubs": "D:/Media/AutoSubs/autosubs.exe",
  "autoSubsModel": "base",
  "autoSubsLanguage": "zh",
  "qwenPython": "D:/Media/qwen/.venv/Scripts/python.exe",
  "qwenModel": "D:/Media/models/Qwen3-TTS-12Hz-0.6B-Base",
  "qwenDevice": "cpu",
  "qwenLanguage": "Chinese",
  "museRoot": "D:/Media/MuseTalk",
  "musePython": "D:/Media/MuseTalk/.venv/Scripts/python.exe",
  "aerender": "D:/Adobe/After Effects/Support Files/aerender.exe",
  "nexrender": "D:/Media/nexrender-cli-win64.exe",
  "templates": {
    "intro": { "kind": "lottie", "path": "D:/Media/templates/intro.json", "textLayers": { "title": "Title" }, "imageAsset": "image_0" },
    "price": { "kind": "pag", "path": "D:/Media/templates/price.pag", "textLayers": { "title": 0 }, "imageIndex": 0 },
    "brand": { "kind": "ae_template", "path": "D:/Media/templates/brand.aep", "composition": "Main", "outputModule": "Director RGBA MOV", "textLayers": { "title": "Title" }, "imageLayer": "Product" }
  }
}
~~~

- 安装动效播放器可执行 npm install --prefix D:/Media/motion playwright-core@1.65.1 lottie-web@5.13.0 libpag@4.3.51。这里固定的 libpag 包包含 UMD 和 WASM 两份运行文件。Chrome 在无头模式逐帧绘制，FFmpeg 输出含透明通道的 MOV，再合成到项目里。
- 已选正式配音且留空镜头字幕时，可调用已登记的本机 AutoSubs 转写并生成带时间点的字幕，模型需先在 AutoSubs 安装。填写镜头字幕可使用人工校订文本。[AutoSubs CLI](https://github.com/tmoroney/auto-subs/blob/main/CLI.md)
- 声音克隆使用 Qwen3-TTS 的 Base 权重和 speech_tokenizer 子目录。在媒体 Python 环境安装 qwen-tts、匹配的 torch / torchaudio 和 soundfile；缺少系统 SoX 等依赖时按该模型安装说明补齐。参考录音的逐字稿可在音色素材备注填写；未提供时使用声纹模式。CPU 可用但生成速度依机器性能而异。[Qwen3-TTS 安装与模型权重](https://github.com/QwenLM/Qwen3-TTS)
- 口型使用可运行官方 inference 命令的 MuseTalk 1.5、CUDA 环境、完整辅助模型及 FFmpeg。渲染任务在隔离的相对路径读取输入、输出，不修改官方模型。[MuseTalk 部署说明](https://github.com/TMElyralab/MuseTalk)
- 原生 AE 使用独立 nexrender CLI、After Effects 的 aerender、已安装字体/插件，以及事先在该工作站配置好的带 Alpha 的 MOV 输出模块。合成名、图层名和输出模块须与工程完全一致。[nexrender](https://github.com/inlife/nexrender)
- 编辑配置后，在对应 Python 环境运行 python director_media.py --capabilities 检查引擎和模板清单。能发现依赖代表可尝试使用，首次部署时请用具体模板和授权样片做一次真实导出。
