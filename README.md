# English Learning Plugin

AI-powered English learning tools for VS Code.

## Features

- Translate selected English text to Chinese, or selected Chinese text to natural English.
- Explain selected text with vocabulary, grammar notes, examples, and practice prompts.
- Generate `.enlearn` study blocks from selected text.
- Store DeepSeek API keys in VS Code SecretStorage instead of project files.
- Register the `.enlearn` language with built-in syntax highlighting and snippets.
- Highlight English words in `.enlearn` files with a fixed blue decoration.
- Report `.enlearn` format errors locally, and use DeepSeek for English spelling, usage, and grammar diagnostics when an API key is configured.
- Predict natural English sentence continuations in `.enlearn` files with inline ghost text and show the Chinese translation in hover.

## Commands

- `English Learning Plugin: Translate Selection`
- `English Learning Plugin: Explain Selection`
- `English Learning Plugin: Annotate Selection`
- `English Learning Plugin: Insert .enlearn Learning Block`
- `English Learning Plugin: Summarize Learning Content`
- `English Learning Plugin: Set DeepSeek API Key`

## Keybindings

The default keybindings are active only in `.enlearn` files.

- `Ctrl+Alt+Q`: Explain selected content.
- `Ctrl+Alt+W`: Translate selected content between Chinese and English.
- `Ctrl+Alt+E`: Summarize selected content, or summarize the whole current `.enlearn` file when nothing is selected.
- `Ctrl+Alt+A`: Insert an `.enlearn` learning block from selected content.

If another extension uses the same shortcut in the same context, override the binding in VS Code Keyboard Shortcuts.

## Settings

- `englishLearning.deepseek.baseUrl`: DeepSeek OpenAI-compatible API base URL. Defaults to `https://api.deepseek.com`.
- `englishLearning.deepseek.model`: DeepSeek model for learning commands. Defaults to `deepseek-v4-flash`.
- `englishLearning.deepseek.temperature`: Sampling temperature. Defaults to `0.2`.
- `englishLearning.validation.enabled`: Enable `.enlearn` diagnostics. Defaults to `true`.
- `englishLearning.validation.ai.enabled`: Use DeepSeek for spelling, usage, and grammar diagnostics. Defaults to `true`.
- `englishLearning.validation.debounceMs`: Delay before AI validation after edits. Defaults to `1500`.
- `englishLearning.highlight.englishWords.enabled`: Enable fixed-color English word highlighting. Defaults to `true`.
- `englishLearning.highlight.englishWords.color`: English word decoration color. Defaults to `#2F80ED`.
- `englishLearning.prediction.enabled`: Enable AI inline English sentence predictions. Defaults to `true`.
- `englishLearning.prediction.showTranslationHover`: Show Chinese translation hover for the latest prediction. Defaults to `true`.
- `englishLearning.prediction.maxContextChars`: Maximum context sent for predictions. Defaults to `1200`.
- `englishLearning.prediction.debounceMs`: Delay before requesting inline predictions. Defaults to `800`.

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
