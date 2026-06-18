export interface EnglishLearningAction {
	id: string;
	label: string;
	command: string;
	shortcut: string;
	iconPath: string;
	actionIconPath: string;
	requiresSelection: boolean;
}

export const ENGLISH_LEARNING_ACTIONS: EnglishLearningAction[] = [
	{
		id: 'explainSelection',
		label: '解释选中文本',
		command: 'englishLearning.explainSelection',
		shortcut: 'Ctrl+Shift+Alt+Q',
		iconPath: 'resources/keys/key-q.png',
		actionIconPath: 'resources/actions/action-explain.png',
		requiresSelection: true
	},
	{
		id: 'translateSelection',
		label: '中英互译',
		command: 'englishLearning.translateSelection',
		shortcut: 'Ctrl+Shift+Alt+W',
		iconPath: 'resources/keys/key-w.png',
		actionIconPath: 'resources/actions/action-translate.png',
		requiresSelection: true
	},
	{
		id: 'summarizeLearningContent',
		label: '总结学习内容',
		command: 'englishLearning.summarizeLearningContent',
		shortcut: 'Ctrl+Shift+Alt+E',
		iconPath: 'resources/keys/key-e.png',
		actionIconPath: 'resources/actions/action-summarize.png',
		requiresSelection: false
	},
	{
		id: 'practiceOrGradeSelection',
		label: '练习/批改',
		command: 'englishLearning.practiceOrGradeSelection',
		shortcut: 'Ctrl+Shift+Alt+C',
		iconPath: 'resources/keys/key-c.png',
		actionIconPath: 'resources/actions/action-practice.png',
		requiresSelection: false
	},
	{
		id: 'insertEnlearnBlock',
		label: '插入学习块',
		command: 'englishLearning.insertEnlearnBlock',
		shortcut: 'Ctrl+Shift+Alt+Z',
		iconPath: 'resources/keys/key-z.png',
		actionIconPath: 'resources/actions/action-block.png',
		requiresSelection: true
	},
	{
		id: 'generateRelatedWords',
		label: '生成相关词',
		command: 'englishLearning.generateRelatedWords',
		shortcut: 'Ctrl+Shift+Alt+X',
		iconPath: 'resources/keys/key-x.png',
		actionIconPath: 'resources/actions/action-related.png',
		requiresSelection: false
	},
	{
		id: 'playSelectionAudio',
		label: '播放发音',
		command: 'englishLearning.playSelectionAudio',
		shortcut: 'Ctrl+Shift+Alt+D',
		iconPath: 'resources/keys/key-d.png',
		actionIconPath: 'resources/actions/action-audio.png',
		requiresSelection: true
	}
];
