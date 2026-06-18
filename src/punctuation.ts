const ASCII_PUNCTUATION_REPLACEMENTS: Array<[RegExp, string]> = [
	[/，/g, ','],
	[/。/g, '.'],
	[/！/g, '!'],
	[/？/g, '?'],
	[/：/g, ':'],
	[/；/g, ';'],
	[/、/g, ','],
	[/（/g, '('],
	[/）/g, ')'],
	[/【/g, '['],
	[/】/g, ']'],
	[/《/g, '<'],
	[/》/g, '>'],
	[/“|”/g, '"'],
	[/‘|’/g, "'"],
	[/…/g, '...'],
	[/—/g, '-'],
	[/～/g, '~'],
	[/．/g, '.'],
	[/／/g, '/']
];

export function normalizeAsciiPunctuation(value: string) {
	return ASCII_PUNCTUATION_REPLACEMENTS.reduce(
		(result, [pattern, replacement]) => result.replace(pattern, replacement),
		value
	);
}
