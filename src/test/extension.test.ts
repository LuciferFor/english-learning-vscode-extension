import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	extractCheckableEnglishSegments,
	findChineseText,
	findCommentText,
	findEnglishWords,
	findFeedbackLines,
	findQuestionLines,
	hashText,
	parseAiValidationIssues,
	validateEnlearnFormatText
} from '../enlearnValidation';
import { normalizeAsciiPunctuation } from '../punctuation';
import {
	buildPredictionContext,
	parsePredictionResult,
	shouldTriggerPrediction
} from '../enlearnPrediction';
import {
	formatRelatedWordBlock,
	getEnglishWordAt,
	normalizeRelatedWordInput,
	parseRelatedWordsResult
} from '../relatedWords';
import { ENGLISH_LEARNING_ACTIONS } from '../sidebarActions';
import {
	buildAnswerQuestionInput,
	estimateAnswerQuestionTokens,
	formatQuestionAnswer,
	parsePracticeBatchItems,
	SIDEBAR_ACTION_ICON_SIZE_PX,
	SIDEBAR_KEY_ICON_SIZE_PX
} from '../extension';
import {
	DEFAULT_TTS_SETTINGS,
	buildPowerShellMediaPlayerScript,
	createTtsCacheKey,
	normalizeTtsText,
	toTtsValidationMessage,
	validateTtsText
} from '../tts';
import {
	collectSentenceContext,
	formatInlineTranslation,
	formatPsExplanation,
	getLineAfterSelections,
	isSingleEnglishWord,
	normalizeInsertedTranslation
} from '../textInsertion';

interface EnglishLearningTestExports {
	setDeepSeekTestOverrides(overrides?: {
		apiKey?: string;
		requester?: (apiKey: string, mode: string, text: string) => Promise<unknown>;
	}): void;
}

suite('English Learning Plugin extension', () => {
	test('registers .enlearn language', async () => {
		const languages = await vscode.languages.getLanguages();
		assert.ok(languages.includes('enlearn'));
	});

	test('contributes English Learning Plugin commands', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);
		await extension.activate();

		const commands = await vscode.commands.getCommands(true);

		assert.ok(commands.includes('englishLearning.translateSelection'));
		assert.ok(commands.includes('englishLearning.explainSelection'));
		assert.ok(commands.includes('englishLearning.annotateSelection'));
		assert.ok(commands.includes('englishLearning.insertEnlearnBlock'));
		assert.ok(commands.includes('englishLearning.summarizeLearningContent'));
		assert.ok(commands.includes('englishLearning.answerSelectedQuestion'));
		assert.ok(commands.includes('englishLearning.practiceOrGradeSelection'));
		assert.ok(commands.includes('englishLearning.generateRelatedWords'));
		assert.ok(commands.includes('englishLearning.insertRelatedWord'));
		assert.ok(commands.includes('englishLearning.playSelectionAudio'));
		assert.ok(commands.includes('englishLearning.setApiKey'));
	});

	test('contributes only .enlearn scoped default keybindings', () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);

		const keybindings = extension.packageJSON.contributes.keybindings as Array<{
			command: string;
			key: string;
			when: string;
		}>;

		assert.strictEqual(keybindings.length, 8);
		assert.deepStrictEqual(keybindings.map(item => [item.key, item.command]), [
			['ctrl+shift+alt+q', 'englishLearning.explainSelection'],
			['ctrl+shift+alt+w', 'englishLearning.translateSelection'],
			['ctrl+shift+alt+e', 'englishLearning.summarizeLearningContent'],
			['ctrl+shift+alt+a', 'englishLearning.answerSelectedQuestion'],
			['ctrl+shift+alt+c', 'englishLearning.practiceOrGradeSelection'],
			['ctrl+shift+alt+z', 'englishLearning.insertEnlearnBlock'],
			['ctrl+shift+alt+x', 'englishLearning.generateRelatedWords'],
			['ctrl+shift+alt+d', 'englishLearning.playSelectionAudio']
		]);

		for (const keybinding of keybindings) {
			assert.ok(keybinding.when.includes('resourceExtname == .enlearn'));
			assert.ok(!keybinding.when.includes('editorLangId == enlearn'));
		}
	});

	test('contributes sidebar view without cramped title buttons', () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);

		const contributes = extension.packageJSON.contributes;
		assert.ok(contributes.viewsContainers.activitybar.some((item: { id: string }) => item.id === 'englishLearning'));
		const actionsView = contributes.views.englishLearning.find((item: { id: string }) => item.id === 'englishLearning.actionsView');
		assert.ok(actionsView);
		assert.strictEqual(actionsView.type, 'webview');
		assert.strictEqual(contributes.menus['view/title'], undefined);
		assert.ok(contributes.menus['editor/context'].some((item: { command: string }) => item.command === 'englishLearning.answerSelectedQuestion'));
		assert.ok(contributes.menus['editor/context'].some((item: { command: string }) => item.command === 'englishLearning.generateRelatedWords'));
		assert.ok(contributes.menus['editor/context'].some((item: { command: string }) => item.command === 'englishLearning.playSelectionAudio'));
	});

	test('sidebar actions use Chinese labels and keep shortcuts visible', () => {
		assert.deepStrictEqual(ENGLISH_LEARNING_ACTIONS.map(action => action.label), [
			'解释选中文本',
			'中英互译',
			'总结学习内容',
			'回答问题',
			'练习/批改',
			'插入学习块',
			'生成相关词',
			'播放发音'
		]);
		assert.deepStrictEqual(ENGLISH_LEARNING_ACTIONS.map(action => action.shortcut), [
			'Ctrl+Shift+Alt+Q',
			'Ctrl+Shift+Alt+W',
			'Ctrl+Shift+Alt+E',
			'Ctrl+Shift+Alt+A',
			'Ctrl+Shift+Alt+C',
			'Ctrl+Shift+Alt+Z',
			'Ctrl+Shift+Alt+X',
			'Ctrl+Shift+Alt+D'
		]);
		assert.deepStrictEqual(ENGLISH_LEARNING_ACTIONS.map(action => action.iconPath), [
			'resources/keys/key-q.png',
			'resources/keys/key-w.png',
			'resources/keys/key-e.png',
			'resources/keys/key-a.png',
			'resources/keys/key-c.png',
			'resources/keys/key-z.png',
			'resources/keys/key-x.png',
			'resources/keys/key-d.png'
		]);
		assert.deepStrictEqual(ENGLISH_LEARNING_ACTIONS.map(action => action.actionIconPath), [
			'resources/actions/action-explain.png',
			'resources/actions/action-translate.png',
			'resources/actions/action-summarize.png',
			'resources/actions/action-answer.png',
			'resources/actions/action-practice.png',
			'resources/actions/action-block.png',
			'resources/actions/action-related.png',
			'resources/actions/action-audio.png'
		]);

		for (const action of ENGLISH_LEARNING_ACTIONS) {
			assert.ok(action.label.length <= 8);
			assert.ok(action.shortcut.startsWith('Ctrl+Shift+Alt+'));
			assert.ok(action.iconPath.endsWith('.png'));
			assert.ok(action.actionIconPath.startsWith('resources/actions/'));
		}

		assert.ok(SIDEBAR_KEY_ICON_SIZE_PX >= 48);
		assert.ok(SIDEBAR_ACTION_ICON_SIZE_PX >= 40);
		assert.ok(SIDEBAR_ACTION_ICON_SIZE_PX <= 48);
	});

	test('contributes validation and highlighting settings', () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);

		const properties = extension.packageJSON.contributes.configuration.properties as Record<string, unknown>;
		const configurationDefaults = extension.packageJSON.contributes.configurationDefaults as Record<string, Record<string, unknown>>;

		assert.ok(properties['englishLearning.validation.enabled']);
		assert.ok(properties['englishLearning.validation.ai.enabled']);
		assert.ok(properties['englishLearning.validation.debounceMs']);
		assert.ok(properties['englishLearning.highlight.englishWords.enabled']);
		assert.ok(properties['englishLearning.highlight.englishWords.color']);
		assert.ok(properties['englishLearning.highlight.chineseText.enabled']);
		assert.ok(properties['englishLearning.highlight.chineseText.color']);
		assert.strictEqual((properties['englishLearning.highlight.chineseText.color'] as { default: string }).default, '#F2994A');
		assert.ok(properties['englishLearning.highlight.questionLine.enabled']);
		assert.ok(properties['englishLearning.highlight.questionLine.color']);
		assert.strictEqual((properties['englishLearning.highlight.questionLine.color'] as { default: string }).default, '#56CCF2');
		assert.ok(properties['englishLearning.highlight.feedbackLine.enabled']);
		assert.ok(properties['englishLearning.highlight.feedbackLine.color']);
		assert.strictEqual((properties['englishLearning.highlight.feedbackLine.color'] as { default: string }).default, '#F2C94C');
		assert.ok(properties['englishLearning.highlight.commentText.enabled']);
		assert.ok(properties['englishLearning.highlight.commentText.color']);
		assert.strictEqual((properties['englishLearning.highlight.commentText.color'] as { default: string }).default, '#8A8A8A');
		assert.ok(properties['englishLearning.prediction.enabled']);
		assert.ok(properties['englishLearning.prediction.showTranslationHover']);
		assert.ok(properties['englishLearning.prediction.maxContextChars']);
		assert.ok(properties['englishLearning.prediction.debounceMs']);
		assert.ok(properties['englishLearning.tts.voice']);
		assert.ok(properties['englishLearning.tts.lang']);
		assert.ok(properties['englishLearning.tts.rate']);
		assert.ok(properties['englishLearning.tts.pitch']);
		assert.ok(properties['englishLearning.tts.volume']);
		assert.ok(properties['englishLearning.tts.timeoutMs']);
		assert.ok(properties['englishLearning.tts.maxTextLength']);
		assert.strictEqual((properties['englishLearning.tts.voice'] as { default: string }).default, DEFAULT_TTS_SETTINGS.voice);
		assert.strictEqual((properties['englishLearning.tts.lang'] as { default: string }).default, DEFAULT_TTS_SETTINGS.lang);
		assert.strictEqual((properties['englishLearning.tts.volume'] as { default: string }).default, '+100%');
		assert.strictEqual(configurationDefaults['[enlearn]']['editor.unicodeHighlight.ambiguousCharacters'], false);
		assert.strictEqual((configurationDefaults['[enlearn]']['editor.unicodeHighlight.allowedCharacters'] as Record<string, boolean>)['；'], true);
	});

	test('matches English words, contractions, and hyphenated words', () => {
		const words = findEnglishWords("English words don't miss reading-speed.").map(match => match.text);

		assert.deepStrictEqual(words, ['English', 'words', "don't", 'miss', 'reading-speed']);
	});

	test('matches Chinese text for orange highlighting', () => {
		const matches = findChineseText([
			'我想要学习英语',
			'I need to improve my speaking.',
			'= 我需要去改进我的口语。'
		].join('\n'));

		assert.deepStrictEqual(matches.map(match => match.text), ['我想要学习英语', '我需要去改进我的口语。']);
		assert.strictEqual(matches[0].line, 0);
		assert.strictEqual(matches[1].line, 2);
	});

	test('matches parenthetical notes and line comments for grey highlighting', () => {
		const matches = findCommentText([
			'I want an apple. (PS: 这里解释 an 的用法.)',
			'// comment 注释内容',
			'I need (课程) today.'
		].join('\n'));

		assert.deepStrictEqual(matches.map(match => match.text), [
			'(PS: 这里解释 an 的用法.)',
			'// comment 注释内容',
			'(课程)'
		]);
		assert.strictEqual(matches[0].line, 0);
		assert.strictEqual(matches[1].startCharacter, 0);
		assert.strictEqual(matches[2].line, 2);
	});

	test('matches question and feedback lines for semantic highlighting', () => {
		const text = [
			'? translate 我需要提高我的英语口语.',
			'  ? cloze I want to ____ English documents.',
			'I need help? This is not a question line.',
			'! 批改: 正确. 回答正确.',
			'Text ! not feedback.'
		].join('\n');

		const questionLines = findQuestionLines(text);
		const feedbackLines = findFeedbackLines(text);

		assert.deepStrictEqual(questionLines.map(match => match.line), [0, 1]);
		assert.strictEqual(questionLines[0].text, '? translate 我需要提高我的英语口语.');
		assert.deepStrictEqual(feedbackLines.map(match => match.line), [3]);
		assert.strictEqual(feedbackLines[0].text, '! 批改: 正确. 回答正确.');
	});

	test('validates local .enlearn format issues', () => {
		const issues = validateEnlearnFormatText([
			'@ bad',
			'[word]',
			': typo value',
			'? cloze I need {improve} this'
		].join('\n'));

		assert.ok(issues.some(issue => issue.message.includes('元数据')));
		assert.ok(issues.some(issue => issue.message.includes('[word]')));
		assert.ok(issues.some(issue => issue.message.includes('未知词条字段')));
		assert.ok(issues.some(issue => issue.message.includes('cloze')));
	});

	test('calculates next-line translation insertion point', () => {
		assert.strictEqual(getLineAfterSelections([{
			startLine: 1,
			startCharacter: 2,
			endLine: 1,
			endCharacter: 10
		}]), 2);
		assert.strictEqual(getLineAfterSelections([{
			startLine: 1,
			startCharacter: 0,
			endLine: 2,
			endCharacter: 0
		}]), 2);
		assert.strictEqual(normalizeInsertedTranslation('\n我想学习英语。\n'), '我想学习英语.');
		assert.strictEqual(isSingleEnglishWord('lesson'), true);
		assert.strictEqual(isSingleEnglishWord("don't"), true);
		assert.strictEqual(isSingleEnglishWord('reading-speed'), true);
		assert.strictEqual(isSingleEnglishWord('one lesson'), false);
		assert.strictEqual(formatInlineTranslation('（课程。）'), '(课程)');
		assert.strictEqual(normalizeAsciiPunctuation('中文，标点：示例；结束。'), '中文,标点:示例;结束.');
	});

	test('collects sentence context and formats inline PS explanations', () => {
		const context = collectSentenceContext([
			{ lineNumber: 0, text: 'I want an apple.' },
			{ lineNumber: 1, text: 'Next sentence.' }
		], {
			startLine: 0,
			startCharacter: 7,
			endLine: 0,
			endCharacter: 9
		});

		assert.strictEqual(context.text, 'I want an apple.');
		assert.strictEqual(context.endLine, 0);
		const multiline = collectSentenceContext([
			{ lineNumber: 0, text: '> I want' },
			{ lineNumber: 1, text: '> an apple.' },
			{ lineNumber: 2, text: '= 我想要一个苹果。' }
		], {
			startLine: 1,
			startCharacter: 2,
			endLine: 1,
			endCharacter: 4
		});

		assert.strictEqual(multiline.text, '> I want\n> an apple.');
		assert.strictEqual(multiline.endLine, 1);
		assert.strictEqual(
			formatPsExplanation('PS: an 用在 apple 前，因为 apple 以元音音素开头。'),
			'(PS: an 用在 apple 前,因为 apple 以元音音素开头.)'
		);
		assert.strictEqual(
			formatPsExplanation('（PS: an 是不定冠词，用于 apple 前。）'),
			'(PS: an 是不定冠词,用于 apple 前.)'
		);
	});

	test('explain command inserts inline PS after the sentence instead of replacing selected text', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);
		const exports = await extension.activate() as EnglishLearningTestExports;

		exports.setDeepSeekTestOverrides({
			apiKey: 'test-api-key',
			requester: async (_apiKey, mode, text) => {
				assert.strictEqual(mode, 'contextExplain');
				assert.ok(text.includes('Selected text: an'));
				assert.ok(text.includes('Sentence context:'));
				assert.ok(text.includes('I want an apple.'));

				return {
					options: {
						baseUrl: 'https://api.deepseek.com',
						model: 'deepseek-v4-flash',
						temperature: 0.2
					},
					result: {
						explanation: 'an 用在 apple 前，因为 apple 以元音音素开头。',
						notes: [],
						grammar: [],
						examples: [],
						practice: [],
						vocabulary: [],
						direction: 'en-to-zh'
					}
				};
			}
		});

		try {
			const document = await vscode.workspace.openTextDocument({
				content: 'I want an apple.\n',
				language: 'enlearn'
			});
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(
				new vscode.Position(0, 7),
				new vscode.Position(0, 9)
			);

			await vscode.commands.executeCommand('englishLearning.explainSelection');

			assert.strictEqual(
				document.getText(),
				'I want an apple.(PS: an 用在 apple 前,因为 apple 以元音音素开头.)\n'
			);
		} finally {
			exports.setDeepSeekTestOverrides();
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}
	});

	test('translate command inserts word meaning inline for single-word selection', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);
		const exports = await extension.activate() as EnglishLearningTestExports;

		exports.setDeepSeekTestOverrides({
			apiKey: 'test-api-key',
			requester: async (_apiKey, mode, text) => {
				assert.strictEqual(mode, 'contextTranslate');
				assert.ok(text.includes('Selected word: lesson'));
				assert.ok(text.includes('I will learn one lesson per day.'));

				return {
					options: {
						baseUrl: 'https://api.deepseek.com',
						model: 'deepseek-v4-flash',
						temperature: 0.2
					},
					result: {
						translation: '课',
						notes: [],
						grammar: [],
						examples: [],
						practice: [],
						vocabulary: [],
						direction: 'en-to-zh'
					}
				};
			}
		});

		try {
			const document = await vscode.workspace.openTextDocument({
				content: 'I will learn one lesson per day.\n',
				language: 'enlearn'
			});
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(
				new vscode.Position(0, 17),
				new vscode.Position(0, 23)
			);

			await vscode.commands.executeCommand('englishLearning.translateSelection');

			assert.strictEqual(
				document.getText(),
				'I will learn one lesson(课) per day.\n'
			);
		} finally {
			exports.setDeepSeekTestOverrides();
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}
	});

	test('translate command still inserts sentence translation on next line', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);
		const exports = await extension.activate() as EnglishLearningTestExports;

		exports.setDeepSeekTestOverrides({
			apiKey: 'test-api-key',
			requester: async (_apiKey, mode, text) => {
				assert.strictEqual(mode, 'translate');
				assert.strictEqual(text, 'I can study every day.');

				return {
					options: {
						baseUrl: 'https://api.deepseek.com',
						model: 'deepseek-v4-flash',
						temperature: 0.2
					},
					result: {
						translation: '我每天都能学习。',
						notes: [],
						grammar: [],
						examples: [],
						practice: [],
						vocabulary: [],
						direction: 'en-to-zh'
					}
				};
			}
		});

		try {
			const document = await vscode.workspace.openTextDocument({
				content: 'I can study every day.\n',
				language: 'enlearn'
			});
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(
				new vscode.Position(0, 0),
				new vscode.Position(0, 22)
			);

			await vscode.commands.executeCommand('englishLearning.translateSelection');

			assert.strictEqual(
				document.getText(),
				'I can study every day.\n我每天都能学习.\n'
			);
		} finally {
			exports.setDeepSeekTestOverrides();
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}
	});

	test('builds answer-question context from selected question and nearby lines only', () => {
		const documentText = [
			'far before 0',
			'near before 1',
			'near before 2',
			'near before 3',
			'? Why do we use an before apple?',
			'near after 1',
			'near after 2',
			'near after 3',
			'far after 4'
		].join('\n');

		const input = buildAnswerQuestionInput(documentText, '? Why do we use an before apple?', [{
			startLine: 4,
			startCharacter: 0,
			endLine: 4,
			endCharacter: 32
		}]);

		assert.ok(input);
		assert.ok(input.includes('Selected question:'));
		assert.ok(input.includes('near before 1'));
		assert.ok(input.includes('near before 2'));
		assert.ok(input.includes('near before 3'));
		assert.ok(input.includes('near after 1'));
		assert.ok(input.includes('near after 2'));
		assert.ok(input.includes('near after 3'));
		assert.ok(!input.includes('far before 0'));
		assert.ok(!input.includes('far after 4'));
	});

	test('answer-question context trims support lines and rejects oversized questions', () => {
		const longContext = 'context '.repeat(200);
		const trimmed = buildAnswerQuestionInput([
			longContext,
			'? Short question?',
			longContext
		].join('\n'), '? Short question?', [{
			startLine: 1,
			startCharacter: 0,
			endLine: 1,
			endCharacter: 17
		}], 20);

		assert.ok(trimmed);
		assert.ok(trimmed.includes('? Short question?'));
		assert.ok(!trimmed.includes(longContext));
		assert.ok(estimateAnswerQuestionTokens('word '.repeat(5000)) > 1000);
		assert.strictEqual(buildAnswerQuestionInput('word '.repeat(5000), 'word '.repeat(5000), [{
			startLine: 0,
			startCharacter: 0,
			endLine: 0,
			endCharacter: 10
		}]), undefined);
	});

	test('formats question answers as one feedback line', () => {
		assert.strictEqual(
			formatQuestionAnswer('! 回答：因为 apple 以元音音素开头。\n所以用 an。'),
			'! 回答: 因为 apple 以元音音素开头. 所以用 an.'
		);
	});

	test('answer question command inserts AI answer below selected question', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);
		const exports = await extension.activate() as EnglishLearningTestExports;

		exports.setDeepSeekTestOverrides({
			apiKey: 'test-api-key',
			requester: async (_apiKey, mode, text) => {
				assert.strictEqual(mode, 'answerQuestion');
				assert.ok(text.includes('Selected question:'));
				assert.ok(text.includes('? Why do we use an before apple?'));
				assert.ok(text.includes('I want an apple.'));
				assert.ok(text.includes('apple starts with a vowel sound.'));
				assert.ok(!text.includes('# Far header'));

				return {
					options: {
						baseUrl: 'https://api.deepseek.com',
						model: 'deepseek-v4-flash',
						temperature: 0.2
					},
					result: {
						answer: '因为 apple 以元音音素开头。\n所以用 an。',
						notes: [],
						grammar: [],
						examples: [],
						practice: [],
						vocabulary: [],
						questions: [],
						gradings: [],
						direction: 'mixed'
					}
				};
			}
		});

		try {
			const document = await vscode.workspace.openTextDocument({
				content: [
					'# Far header',
					'@topic Fruit',
					'[word] apple',
					'I want an apple.',
					'? Why do we use an before apple?',
					'apple starts with a vowel sound.'
				].join('\n') + '\n',
				language: 'enlearn'
			});
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(
				new vscode.Position(4, 0),
				new vscode.Position(4, 32)
			);

			await vscode.commands.executeCommand('englishLearning.answerSelectedQuestion');

			assert.strictEqual(
				document.getText(),
				[
					'# Far header',
					'@topic Fruit',
					'[word] apple',
					'I want an apple.',
					'? Why do we use an before apple?',
					'! 回答: 因为 apple 以元音音素开头. 所以用 an.',
					'apple starts with a vowel sound.'
				].join('\n') + '\n'
			);
		} finally {
			exports.setDeepSeekTestOverrides();
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}
	});

	test('practice command appends three unanswered questions without selection', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);
		const exports = await extension.activate() as EnglishLearningTestExports;

		exports.setDeepSeekTestOverrides({
			apiKey: 'test-api-key',
			requester: async (_apiKey, mode, text) => {
				assert.strictEqual(mode, 'practice');
				assert.ok(text.includes('I can study every day.'));

				return {
					options: {
						baseUrl: 'https://api.deepseek.com',
						model: 'deepseek-v4-flash',
						temperature: 0.2
					},
					result: {
						notes: [],
						grammar: [],
						examples: [],
						practice: [],
						vocabulary: [],
						questions: [
							{ type: 'translate', prompt: '我每天都能学习。' },
							{ type: 'cloze', prompt: 'I can ____ every day.' },
							{ type: 'translate', prompt: 'I will learn one lesson per day.' }
						],
						direction: 'mixed'
					}
				};
			}
		});

		try {
			const document = await vscode.workspace.openTextDocument({
				content: '# Unit\n\n## Text\n> I can study every day.\n',
				language: 'enlearn'
			});
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(
				new vscode.Position(0, 0),
				new vscode.Position(0, 0)
			);

			await vscode.commands.executeCommand('englishLearning.practiceOrGradeSelection');

			const text = document.getText();
			assert.ok(text.includes('## Practice: AI Review '));
			assert.ok(text.includes('? translate 我每天都能学习.'));
			assert.ok(text.includes('? cloze I can ____ every day.'));
			assert.ok(text.includes('? translate I will learn one lesson per day.'));
			assert.ok(!text.includes('{'));
		} finally {
			exports.setDeepSeekTestOverrides();
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}
	});

	test('practice command inserts wrong-answer grading below selected answer', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);
		const exports = await extension.activate() as EnglishLearningTestExports;

		exports.setDeepSeekTestOverrides({
			apiKey: 'test-api-key',
			requester: async (_apiKey, mode, text) => {
				assert.strictEqual(mode, 'gradePractice');
				assert.ok(text.includes('Learner answer:'));
				assert.ok(text.includes('I studying every day.'));

				return {
					options: {
						baseUrl: 'https://api.deepseek.com',
						model: 'deepseek-v4-flash',
						temperature: 0.2
					},
					result: {
						notes: [],
						grammar: [],
						examples: [],
						practice: [],
						vocabulary: [],
						questions: [],
						grading: {
							correct: false,
							feedback: '动词形式不对。',
							correction: 'I study every day.',
							explanation: 'can 后应接动词原形，不能用 studying。'
						},
						direction: 'mixed'
					}
				};
			}
		});

		try {
			const document = await vscode.workspace.openTextDocument({
				content: 'I studying every day.\nNext line.\n',
				language: 'enlearn'
			});
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(
				new vscode.Position(0, 0),
				new vscode.Position(0, 21)
			);

			await vscode.commands.executeCommand('englishLearning.practiceOrGradeSelection');

			assert.strictEqual(
				document.getText(),
				'I studying every day.\n! 批改: 错误. 动词形式不对. 建议: I study every day. 原因: can 后应接动词原形,不能用 studying.\nNext line.\n'
			);
		} finally {
			exports.setDeepSeekTestOverrides();
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}
	});

	test('practice command inserts correct-answer grading below selected answer', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);
		const exports = await extension.activate() as EnglishLearningTestExports;

		exports.setDeepSeekTestOverrides({
			apiKey: 'test-api-key',
			requester: async (_apiKey, mode) => {
				assert.strictEqual(mode, 'gradePractice');

				return {
					options: {
						baseUrl: 'https://api.deepseek.com',
						model: 'deepseek-v4-flash',
						temperature: 0.2
					},
					result: {
						notes: [],
						grammar: [],
						examples: [],
						practice: [],
						vocabulary: [],
						questions: [],
						grading: {
							correct: true,
							feedback: '答案自然，表达正确。'
						},
						direction: 'mixed'
					}
				};
			}
		});

		try {
			const document = await vscode.workspace.openTextDocument({
				content: 'I study every day.\n',
				language: 'enlearn'
			});
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(
				new vscode.Position(0, 0),
				new vscode.Position(0, 18)
			);

			await vscode.commands.executeCommand('englishLearning.practiceOrGradeSelection');

			assert.strictEqual(
				document.getText(),
				'I study every day.\n! 批改: 正确. 答案自然,表达正确.\n'
			);
		} finally {
			exports.setDeepSeekTestOverrides();
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}
	});

	test('parses selected practice question blocks for batch grading', () => {
		const text = [
			'? translate I can study every day.',
			'我每天都能学习.',
			'// learner note should be ignored',
			'! 批改: 旧反馈.',
			'? cloze I can ____ every day.',
			'I can study every day.'
		].join('\n');

		const items = parsePracticeBatchItems(text, [{
			startLine: 0,
			startCharacter: 0,
			endLine: 6,
			endCharacter: 0
		}]);

		assert.strictEqual(items.length, 2);
		assert.strictEqual(items[0].id, 'item-1');
		assert.strictEqual(items[0].question, '? translate I can study every day.');
		assert.strictEqual(items[0].answer, '我每天都能学习.');
		assert.strictEqual(items[0].startLine, 0);
		assert.strictEqual(items[0].endLine, 3);
		assert.strictEqual(items[1].id, 'item-2');
		assert.strictEqual(items[1].question, '? cloze I can ____ every day.');
		assert.strictEqual(items[1].answer, 'I can study every day.');
	});

	test('practice command batch grades selected question blocks below each block', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);
		const exports = await extension.activate() as EnglishLearningTestExports;

		exports.setDeepSeekTestOverrides({
			apiKey: 'test-api-key',
			requester: async (_apiKey, mode, text) => {
				assert.strictEqual(mode, 'gradePracticeBatch');
				const match = text.match(/Practice items JSON:\n([\s\S]*?)\n\n\.enlearn learning content:/);
				assert.ok(match);
				const items = JSON.parse(match[1]) as Array<{ id: string; question: string; answer: string }>;
				assert.strictEqual(items.length, 2);
				assert.deepStrictEqual(items.map(item => item.answer), [
					'我每天都能学习.',
					'I can studying every day.'
				]);
				assert.ok(!items[0].answer.includes('旧反馈'));

				return {
					options: {
						baseUrl: 'https://api.deepseek.com',
						model: 'deepseek-v4-flash',
						temperature: 0.2
					},
					result: {
						notes: [],
						grammar: [],
						examples: [],
						practice: [],
						vocabulary: [],
						questions: [],
						gradings: [
							{ id: 'item-1', correct: true, feedback: '第一题正确。' },
							{
								id: 'item-2',
								correct: false,
								feedback: '第二题语法错误。',
								correction: 'I can study every day.',
								explanation: 'can 后接动词原形。'
							}
						],
						direction: 'mixed'
					}
				};
			}
		});

		try {
			const document = await vscode.workspace.openTextDocument({
				content: [
					'? translate I can study every day.',
					'我每天都能学习.',
					'! 批改: 旧反馈.',
					'? cloze I can ____ every day.',
					'I can studying every day.',
					'After.'
				].join('\n') + '\n',
				language: 'enlearn'
			});
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(
				new vscode.Position(0, 0),
				new vscode.Position(5, 0)
			);

			await vscode.commands.executeCommand('englishLearning.practiceOrGradeSelection');

			assert.strictEqual(
				document.getText(),
				[
					'? translate I can study every day.',
					'我每天都能学习.',
					'! 批改: 旧反馈.',
					'! 批改: 正确. 第一题正确.',
					'? cloze I can ____ every day.',
					'I can studying every day.',
					'! 批改: 错误. 第二题语法错误. 建议: I can study every day. 原因: can 后接动词原形.',
					'After.'
				].join('\n') + '\n'
			);
		} finally {
			exports.setDeepSeekTestOverrides();
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}
	});

	test('practice command inserts unanswered feedback locally without AI batch call', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);
		const exports = await extension.activate() as EnglishLearningTestExports;

		exports.setDeepSeekTestOverrides({
			apiKey: 'test-api-key',
			requester: async () => {
				throw new Error('AI should not be called for unanswered batch items.');
			}
		});

		try {
			const document = await vscode.workspace.openTextDocument({
				content: '? translate I can study every day.\n? cloze I can ____ every day.\n',
				language: 'enlearn'
			});
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(
				new vscode.Position(0, 0),
				new vscode.Position(2, 0)
			);

			await vscode.commands.executeCommand('englishLearning.practiceOrGradeSelection');

			assert.ok(document.getText().includes([
				'? translate I can study every day.',
				'! 批改: 未作答. 请先填写答案.',
				'? cloze I can ____ every day.',
				'! 批改: 未作答. 请先填写答案.'
			].join('\n')));
		} finally {
			exports.setDeepSeekTestOverrides();
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}
	});

	test('extracts changed English segments for incremental AI validation', () => {
		const segments = extractCheckableEnglishSegments([
			'= English in translation line is ignored',
			'@topic English metadata is ignored',
			'[word] improve',
			'// English comment is ignored',
			'# Unit English title is ignored',
			'> He go school.',
			'! This phrase sounds natural.',
			': example I want to improve my speaking.',
			'? cloze I {go|去} home.'
		].join('\n'));

		assert.deepStrictEqual(segments.map(segment => segment.text), [
			'He go school.',
			'This phrase sounds natural.',
			'I want to improve my speaking.',
			'I {go|去} home.'
		]);
		assert.strictEqual(hashText('same'), hashText('same'));
		assert.notStrictEqual(hashText('same'), hashText('different'));
	});

	test('parses AI validation issues', () => {
		const issues = parseAiValidationIssues(JSON.stringify({
			issues: [
				{
					segmentId: 'line-1-abc',
					text: 'He go',
					kind: 'grammar',
					message: '语法错误：主谓不一致。',
					suggestion: 'He goes',
					severity: 'error'
				}
			]
		}));

		assert.strictEqual(issues.length, 1);
		assert.strictEqual(issues[0].kind, 'grammar');
		assert.strictEqual(issues[0].text, 'He go');
		assert.strictEqual(issues[0].segmentId, 'line-1-abc');
		assert.strictEqual(issues[0].message, '语法错误:主谓不一致.');
		assert.strictEqual(issues[0].suggestion, 'He goes');
	});

	test('parses and formats related words', () => {
		const result = parseRelatedWordsResult(JSON.stringify({
			source: 'improve',
			words: [
				{ word: 'enhance', meaning: '提高；增强', domain: '能力提升', example: 'This method can enhance your reading speed.' },
				{ word: 'refine', meaning: '改进；完善' },
				{ word: 'strengthen', meaning: '加强' },
				{ word: 'upgrade', meaning: '升级' },
				{ word: 'develop', meaning: '发展' },
				{ word: 'boost', meaning: '提升' }
			]
		}));

		assert.ok(result);
		assert.strictEqual(result.source, 'improve');
		assert.strictEqual(result.words.length, 5);
		assert.strictEqual(result.words[0].meaning, '提高;增强');
		assert.strictEqual(getEnglishWordAt("I don't like reading-speed.", 4), "don't");
		assert.strictEqual(normalizeRelatedWordInput(' improve this'), 'improve');
		assert.ok(formatRelatedWordBlock(result.words[0]).includes(': note 相关领域: 能力提升'));
	});

	test('normalizes and validates TTS text', () => {
		assert.strictEqual(normalizeTtsText(['  Hello  ', '', ' world.\n']), 'Hello world.');
		assert.strictEqual(validateTtsText('', 10), 'empty');
		assert.strictEqual(validateTtsText('abcdefghijk', 10), 'tooLong');
		assert.strictEqual(validateTtsText('你好', 10), 'noEnglish');
		assert.strictEqual(validateTtsText('Hello', 10), undefined);
		assert.ok(toTtsValidationMessage('tooLong', 10).includes('10'));
	});

	test('creates stable TTS cache keys', () => {
		const first = createTtsCacheKey('Hello.', DEFAULT_TTS_SETTINGS);
		const second = createTtsCacheKey('Hello.', DEFAULT_TTS_SETTINGS);
		const changed = createTtsCacheKey('Hello again.', DEFAULT_TTS_SETTINGS);

		assert.strictEqual(first, second);
		assert.notStrictEqual(first, changed);
	});

	test('builds PowerShell MediaPlayer script safely', () => {
		const script = buildPowerShellMediaPlayerScript("C:\\tmp\\learner's.mp3");

		assert.ok(script.includes('System.Windows.Media.MediaPlayer'));
		assert.ok(script.includes("'C:\\tmp\\learner''s.mp3'"));
		assert.ok(script.includes('Resolve-Path -LiteralPath'));
		assert.ok(script.includes('$player.Volume = 1.0'));
		assert.ok(script.includes('$player.Play()'));
	});

	test('parses prediction result with English completion and Chinese translation', () => {
		const prediction = parsePredictionResult(JSON.stringify({
			completion: 'and practice speaking every day.',
			translation: '并且每天练习口语。'
		}));

		assert.ok(prediction);
		assert.strictEqual(prediction.completion, 'and practice speaking every day.');
		assert.strictEqual(prediction.translation, '并且每天练习口语.');
	});

	test('rejects unsafe prediction completions', () => {
		assert.strictEqual(parsePredictionResult(JSON.stringify({
			completion: '然后每天练习。',
			translation: '然后每天练习。'
		})), undefined);
	});

	test('detects valid and blocked prediction trigger lines', () => {
		assert.strictEqual(shouldTriggerPrediction('> I want to improve'), true);
		assert.strictEqual(shouldTriggerPrediction('! This phrase means'), true);
		assert.strictEqual(shouldTriggerPrediction(': example I want to improve'), true);
		assert.strictEqual(shouldTriggerPrediction('? cloze I need to'), true);
		assert.strictEqual(shouldTriggerPrediction('= 我想提高英语'), false);
		assert.strictEqual(shouldTriggerPrediction('@topic English'), false);
		assert.strictEqual(shouldTriggerPrediction('[word] improve'), false);
		assert.strictEqual(shouldTriggerPrediction('// English comment'), false);
	});

	test('truncates prediction context to max characters', () => {
		const context = buildPredictionContext('abc\ndef\nghi', { line: 2, character: 2 }, 5);

		assert.strictEqual(context.length, 5);
		assert.strictEqual(context, 'ef\ngh');
	});
});
