export interface EnglishLearningAction {
	id: string;
	label: string;
	command: string;
	shortcut: string;
	requiresSelection: boolean;
}

export const ENGLISH_LEARNING_ACTIONS: EnglishLearningAction[] = [
	{
		id: 'explainSelection',
		label: '解释选中文本',
		command: 'englishLearning.explainSelection',
		shortcut: 'Ctrl+Alt+Q',
		requiresSelection: true
	},
	{
		id: 'translateSelection',
		label: '中英互译',
		command: 'englishLearning.translateSelection',
		shortcut: 'Ctrl+Alt+W',
		requiresSelection: true
	},
	{
		id: 'summarizeLearningContent',
		label: '总结学习内容',
		command: 'englishLearning.summarizeLearningContent',
		shortcut: 'Ctrl+Alt+E',
		requiresSelection: false
	},
	{
		id: 'insertEnlearnBlock',
		label: '插入学习块',
		command: 'englishLearning.insertEnlearnBlock',
		shortcut: 'Ctrl+Alt+A',
		requiresSelection: true
	},
	{
		id: 'generateRelatedWords',
		label: '生成相关词',
		command: 'englishLearning.generateRelatedWords',
		shortcut: 'Ctrl+Alt+S',
		requiresSelection: false
	},
	{
		id: 'playSelectionAudio',
		label: '播放发音',
		command: 'englishLearning.playSelectionAudio',
		shortcut: 'Ctrl+Alt+D',
		requiresSelection: true
	}
];
