import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	extractCheckableEnglishSegments,
	findChineseText,
	findEnglishWords,
	hashText,
	parseAiValidationIssues,
	validateEnlearnFormatText
} from '../enlearnValidation';
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
	DEFAULT_TTS_SETTINGS,
	buildPowerShellMediaPlayerScript,
	createTtsCacheKey,
	normalizeTtsText,
	toTtsValidationMessage,
	validateTtsText
} from '../tts';
import {
	collectSentenceContext,
	formatPsExplanation,
	getLineAfterSelections,
	normalizeInsertedTranslation
} from '../textInsertion';

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

		assert.strictEqual(keybindings.length, 6);
		assert.deepStrictEqual(keybindings.map(item => [item.key, item.command]), [
			['ctrl+alt+q', 'englishLearning.explainSelection'],
			['ctrl+alt+w', 'englishLearning.translateSelection'],
			['ctrl+alt+e', 'englishLearning.summarizeLearningContent'],
			['ctrl+alt+a', 'englishLearning.insertEnlearnBlock'],
			['ctrl+alt+s', 'englishLearning.generateRelatedWords'],
			['ctrl+alt+d', 'englishLearning.playSelectionAudio']
		]);

		for (const keybinding of keybindings) {
			assert.ok(keybinding.when.includes('editorLangId == enlearn'));
		}
	});

	test('contributes sidebar view without cramped title buttons', () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);

		const contributes = extension.packageJSON.contributes;
		assert.ok(contributes.viewsContainers.activitybar.some((item: { id: string }) => item.id === 'englishLearning'));
		assert.ok(contributes.views.englishLearning.some((item: { id: string }) => item.id === 'englishLearning.actionsView'));
		assert.strictEqual(contributes.menus['view/title'], undefined);
		assert.ok(contributes.menus['editor/context'].some((item: { command: string }) => item.command === 'englishLearning.generateRelatedWords'));
		assert.ok(contributes.menus['editor/context'].some((item: { command: string }) => item.command === 'englishLearning.playSelectionAudio'));
	});

	test('sidebar actions use Chinese labels and keep shortcuts visible', () => {
		assert.deepStrictEqual(ENGLISH_LEARNING_ACTIONS.map(action => action.label), [
			'解释选中文本',
			'中英互译',
			'总结学习内容',
			'插入学习块',
			'生成相关词',
			'播放发音'
		]);
		assert.deepStrictEqual(ENGLISH_LEARNING_ACTIONS.map(action => action.shortcut), [
			'Ctrl+Alt+Q',
			'Ctrl+Alt+W',
			'Ctrl+Alt+E',
			'Ctrl+Alt+A',
			'Ctrl+Alt+S',
			'Ctrl+Alt+D'
		]);

		for (const action of ENGLISH_LEARNING_ACTIONS) {
			assert.ok(action.label.length <= 8);
			assert.ok(action.shortcut.startsWith('Ctrl+Alt+'));
		}
	});

	test('contributes validation and highlighting settings', () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'english-learning-plugin');
		assert.ok(extension);

		const properties = extension.packageJSON.contributes.configuration.properties as Record<string, unknown>;

		assert.ok(properties['englishLearning.validation.enabled']);
		assert.ok(properties['englishLearning.validation.ai.enabled']);
		assert.ok(properties['englishLearning.validation.debounceMs']);
		assert.ok(properties['englishLearning.highlight.englishWords.enabled']);
		assert.ok(properties['englishLearning.highlight.englishWords.color']);
		assert.ok(properties['englishLearning.highlight.chineseText.enabled']);
		assert.ok(properties['englishLearning.highlight.chineseText.color']);
		assert.strictEqual((properties['englishLearning.highlight.chineseText.color'] as { default: string }).default, '#F2994A');
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
		assert.strictEqual(normalizeInsertedTranslation('\n我想学习英语。\n'), '我想学习英语。');
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
			'（PS: an 用在 apple 前，因为 apple 以元音音素开头。）'
		);
		assert.strictEqual(
			formatPsExplanation('（PS: an 是不定冠词，用于 apple 前。）'),
			'（PS: an 是不定冠词，用于 apple 前。）'
		);
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
		assert.strictEqual(getEnglishWordAt("I don't like reading-speed.", 4), "don't");
		assert.strictEqual(normalizeRelatedWordInput(' improve this'), 'improve');
		assert.ok(formatRelatedWordBlock(result.words[0]).includes(': note 相关领域：能力提升'));
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
		assert.ok(script.includes('$player.Play()'));
	});

	test('parses prediction result with English completion and Chinese translation', () => {
		const prediction = parsePredictionResult(JSON.stringify({
			completion: 'and practice speaking every day.',
			translation: '并且每天练习口语。'
		}));

		assert.ok(prediction);
		assert.strictEqual(prediction.completion, 'and practice speaking every day.');
		assert.strictEqual(prediction.translation, '并且每天练习口语。');
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
