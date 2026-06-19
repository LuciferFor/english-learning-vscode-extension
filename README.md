# 英语学习插件

面向 VS Code 的 AI 英语学习工具。

## 功能

- 对选中的中英文内容做互译、解释、注解和学习块生成；单词互译会插入到词后，句子互译会插入到下一行，解释结果会以 `（PS: ...）` 插入到所在语句后。
- DeepSeek API key 使用 VS Code SecretStorage 保存，不写入项目文件。
- 注册 `.enlearn` 语言，内置语法高亮、片段、英文蓝色高亮和中文橙色高亮。
- 本地检查 `.enlearn` 格式错误，并在配置 API key 后增量检查英文拼写、用词和语法。
- 在 `.enlearn` 中提供英文续写预测，并用 hover 显示中文翻译。
- 回答选中的学习问题，并把 `! 回答: ...` 插入到问题下一行。
- 根据当前 `.enlearn` 学习内容生成 3 道练习题，或批改选中的作答内容。
- 根据选中单词或光标单词生成 5 个相关词。
- 使用 Edge TTS 播放选中英文单词或句子的英式发音。
- 侧边栏提供中文快捷操作列表，快捷键显示在每行右侧；顶部不再放长文字按钮。

## 命令

- `英语学习插件: 中英互译选中文本 (Ctrl+Shift+Alt+W)`
- `英语学习插件: 解释选中文本 (Ctrl+Shift+Alt+Q)`
- `英语学习插件: 生成学习注解`
- `英语学习插件: 插入 .enlearn 学习块 (Ctrl+Shift+Alt+Z)`
- `英语学习插件: 总结学习内容 (Ctrl+Shift+Alt+E)`
- `英语学习插件: 回答选中问题 (Ctrl+Shift+Alt+A)`
- `英语学习插件: 生成/批改练习 (Ctrl+Shift+Alt+C)`
- `英语学习插件: 生成相关词 (Ctrl+Shift+Alt+X)`
- `英语学习插件: 播放发音 (Ctrl+Shift+Alt+D)`
- `英语学习插件: 设置 DeepSeek API Key`

## 快捷键

默认快捷键只在 `.enlearn` 文件中生效。

- `Ctrl+Shift+Alt+Q`：按当前语句上下文解释选中文本，并把 `（PS: ...）` 插入到语句末尾。
- `Ctrl+Shift+Alt+W`：中英互译选中文本；选中单个英文单词时把释义插入到词后，例如 `lesson(课)`，选中句子时把译文插入到下一行。
- `Ctrl+Shift+Alt+E`：总结选中文本；无选中时总结当前 `.enlearn` 文件，并在同目录保存为 `<当前文件名>.summary.md`。
- `Ctrl+Shift+Alt+A`：回答选中的问题；只发送选区和上下各 3 行上下文，答案插入到问题下一行。
- `Ctrl+Shift+Alt+C`：无选中时在文件底部生成 3 道练习；有选中时批改选中答案并把反馈插入下一行。
- `Ctrl+Shift+Alt+Z`：根据选中文本插入 `.enlearn` 学习块。
- `Ctrl+Shift+Alt+X`：根据选中单词或光标单词生成 5 个相关词。
- `Ctrl+Shift+Alt+D`：播放选中英文单词或句子的英式发音。

如果其他扩展在同一上下文占用了相同快捷键，可在 VS Code Keyboard Shortcuts 中覆盖。

## 侧边栏

侧边栏保留大行点击入口，不再在标题栏显示长文字按钮：

- `解释选中文本`，右侧显示 `Ctrl+Shift+Alt+Q · 需选中`。
- `中英互译`，右侧显示 `Ctrl+Shift+Alt+W · 需选中`。
- `总结学习内容`，右侧显示 `Ctrl+Shift+Alt+E · 可直接用`。
- `回答问题`，右侧显示 `Ctrl+Shift+Alt+A · 需选中`。
- `练习/批改`，右侧显示 `Ctrl+Shift+Alt+C · 可直接用`。
- `插入学习块`，右侧显示 `Ctrl+Shift+Alt+Z · 需选中`。
- `生成相关词`，右侧显示 `Ctrl+Shift+Alt+X · 可直接用`。
- `播放发音`，右侧显示 `Ctrl+Shift+Alt+D · 需选中`。

生成相关词后，侧边栏会显示 5 个词汇结果。点击某个结果会插入为 `.enlearn` 的 `[word]` 块。

## Settings

- `englishLearning.deepseek.baseUrl`: DeepSeek OpenAI-compatible API base URL. Defaults to `https://api.deepseek.com`.
- `englishLearning.deepseek.model`：DeepSeek 模型，默认 `deepseek-v4-flash`，走快速非推理模型。
- 所有 DeepSeek 请求都会显式设置 `thinking.type = disabled`，不使用深度思考/推理模式。
- `englishLearning.deepseek.temperature`: Sampling temperature. Defaults to `0.2`.
- `englishLearning.validation.enabled`: Enable `.enlearn` diagnostics. Defaults to `true`.
- `englishLearning.validation.ai.enabled`: Use DeepSeek for spelling, usage, and grammar diagnostics. Defaults to `true`.
- `englishLearning.validation.debounceMs`: Delay before AI validation after edits. Defaults to `1500`.
- `englishLearning.highlight.englishWords.enabled`: Enable fixed-color English word highlighting. Defaults to `true`.
- `englishLearning.highlight.englishWords.color`: English word decoration color. Defaults to `#2F80ED`.
- `englishLearning.highlight.chineseText.enabled`: Enable fixed-color Chinese text highlighting. Defaults to `true`.
- `englishLearning.highlight.chineseText.color`: Chinese text decoration color. Defaults to `#F2994A`.
- `englishLearning.prediction.enabled`: Enable AI inline English sentence predictions. Defaults to `true`.
- `englishLearning.prediction.showTranslationHover`: Show Chinese translation hover for the latest prediction. Defaults to `true`.
- `englishLearning.prediction.maxContextChars`: Maximum context sent for predictions. Defaults to `1200`.
- `englishLearning.prediction.debounceMs`: Delay before requesting inline predictions. Defaults to `800`.
- `englishLearning.tts.voice`: Edge TTS voice for pronunciation playback. Defaults to `en-GB-SoniaNeural`.
- `englishLearning.tts.lang`: TTS language tag. Defaults to `en-GB`.
- `englishLearning.tts.rate`: TTS speech rate. Defaults to `+0%`.
- `englishLearning.tts.pitch`: TTS speech pitch. Defaults to `+0Hz`.
- `englishLearning.tts.volume`: TTS speech volume. Defaults to `+100%`.
- `englishLearning.tts.timeoutMs`: TTS generation timeout. Defaults to `10000`.
- `englishLearning.tts.maxTextLength`: Maximum selected text length for pronunciation playback. Defaults to `500`.

## Pronunciation

Pronunciation playback uses the `node-edge-tts` npm package and Microsoft Edge online TTS. It writes a temporary MP3 under VS Code extension global storage and plays it through Windows media APIs without opening an external player. It does not use your DeepSeek API key. The default voice is `en-GB-SoniaNeural`; set `englishLearning.tts.voice` to `en-GB-RyanNeural` if you prefer a male British voice.

## `.enlearn` Format

Files ending in `.enlearn` use the `enlearn` language mode.

```enlearn
# Unit: Reading 01

@level B1
@topic Daily Work
@source manual
@created 2026-06-18

## Text
> I need to improve my English reading speed.

## Translation
= 我需要提高我的英语阅读速度。

## Vocabulary
[word] improve
: meaning 提高；改善
: phonetic /imˈpruːv/
: example I want to improve my speaking.
: note 常接 skill、ability、performance 等名词。

## Explanation
! improve 表示让某事变得更好，比 make better 更正式。

## Practice
? translate 我需要提高我的英语阅读速度。
? cloze I need to {improve|提高} my English reading speed.
```

## Development

```powershell
npm install
npm run compile
npm run lint
npm test
```

Press `F5` in VS Code to launch an Extension Development Host.
