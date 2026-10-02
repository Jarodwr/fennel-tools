// A deliberately "dumb" sibling of ../grammar.js: every s-expression is
// just a list/sequence/table/atom, with no special-form specialization
// (no fn_form, no symbol_binding, no sequence_arguments — everything that
// isn't a reader macro or a literal is a plain `symbol`, `list`,
// `sequence`, or `table`). It shares the real grammar's lexer/scanner
// infrastructure (comments, strings, numbers, reader macros, multi-symbols
// — all the real-world edge cases already hardened in the main grammar),
// just without the constrained sub-rules that reserve specific shapes for
// `fn`/`let`/`case`/etc.'s arguments.
//
// This exists because those reserved shapes are exactly what makes the
// main grammar fragile mid-edit: typing a plain symbol into what the main
// grammar calls a binding position (e.g. `fn`'s parameter list) can
// legitimately fail to match that position's specific sub-grammar and
// surface as a real tree-sitter ERROR node, even though the text is
// perfectly parseable as generic Fennel. A structural editor (paredit)
// doesn't need to know a form is a binding position to navigate it — it
// just needs a tree that can never fail to parse balanced brackets and
// atoms, which is exactly what this variant guarantees: with no reserved
// shapes, there's nothing content can fail to fit.
//
// Never linked into the Rust crate or any language binding — this is
// wasm-only, loaded directly by fennel-editor's paredit engine. See
// generic/README.md for the build command.
const {
	kv_pair,
	call,
	item,
	colon_string,
	double_quote_string,
	list,
	sequence,
	table,
} = require('../grammar-lib/dsl.js');
const {
	PREC_LAST_RESORT,
	PREC_IMPORTANT,
} = require('../grammar-lib/prec.js');
const {
	READER_MACROS,
	SPECIAL_STANDALONE_SYMBOLS,
} = require('../grammar-lib/constants.js');
const {
	reader_macro_nodes,
	reader_macro_group,
} = require('../grammar-lib/node-utils.js').nodify_reader_macros();

module.exports = grammar({
	// distinct: the external scanner's exported C function names
	// (tree_sitter_fennel_external_scanner_*) are derived from this field,
	// and this variant reuses that same scanner.c unmodified. The two
	// grammars are never linked into the same binary (this one is
	// wasm-only, loaded directly by web-tree-sitter under a distinct
	// filename), so the shared name causes no collision at runtime.
	name: 'fennel_sexp',

	extras: $ => [
		/\s/,
		$.comment,
		',',
	],

	externals: $ => [
		...[...READER_MACROS].map(([name, _char]) => $[`_${name}_reader_macro_char`]),
		$.__reader_macro_count,

		$.__colon_string_start_mark,
		$.__colon_string_end_mark,

		$.shebang,

		$.__token_count,
	],

	word: $ => $.symbol,

	rules: {
		program: $ => seq(
			optional($.shebang),
			repeat($._sexp),
		),

		comment: $ => prec(PREC_LAST_RESORT, seq(
			field('colon', alias(/;+/, ';')),
			field('body', alias(/.*/, $.comment_body)),
		)),

		// No $._form here — that's the entire difference from ../grammar.js.
		_sexp: $ => choice(
			$._reader_macro,
			$._special_override_symbol,
			$.symbol_option,
			$.symbol,
			$.multi_symbol,
			$.multi_symbol_method,
			$.list,
			$.sequence,
			$.table,
			$._literal,
		),

		...reader_macro_nodes,
		_reader_macro: reader_macro_group,

		_list_content: $ => seq(
			call($._sexp),
			repeat(item($._sexp)),
		),

		list: $ => list(optional($._list_content)),

		sequence: $ => sequence(repeat(item($._sexp))),

		table_pair: $ => kv_pair($, {}, { value: choice($._sexp, $._symbol_with_trailing_dot) }),

		table: $ => prec(PREC_LAST_RESORT, table(repeat(item($.table_pair)))),

		_quoted_sexp: $ => choice(
			$._reader_macro,
			$._special_override_symbol,
			$.symbol_option,
			$.symbol,
			$.multi_symbol,
			$.multi_symbol_method,
			alias($._quoted_list, $.list),
			alias($._quoted_sequence, $.sequence),
			alias($._quoted_table, $.table),
			$._literal,
		),

		_quoted_list_content: $ => seq(
			call($._quoted_sexp),
			repeat(item($._quoted_sexp)),
		),
		_quoted_list: $ => list(optional($._quoted_list_content)),

		_quoted_sequence: $ => sequence(repeat(item($._quoted_sexp))),

		_quoted_table_pair: $ => kv_pair($, { key: $._quoted_sexp }, { value: $._quoted_sexp }),
		_quoted_table: $ => prec(PREC_LAST_RESORT, table(repeat(item($._quoted_table_pair)))),

		_literal: $ => prec.right(PREC_LAST_RESORT, choice(
			$.string,
			$.number,
			$.boolean,
			$.nil,
		)),

		nil: $ => 'nil',
		boolean: $ => choice('true', 'false'),

		_colon_string: $ => colon_string($, choice(
			...[
				...SPECIAL_STANDALONE_SYMBOLS,
				'nil',
				'true',
				'false',
				/[^(){}\[\]"'~;,@`\s]+/,
			].map(tk => token.immediate(tk))
		)),

		_double_quote_string_content: $ => prec.right(PREC_IMPORTANT, token.immediate(/[^"\\]+/)),
		_double_quote_string: $ => double_quote_string($,
			repeat(choice(
				$._double_quote_string_content,
				$.escape_sequence,
			)),
		),

		string: $ => choice(
			$._colon_string,
			$._double_quote_string,
		),

		escape_sequence: $ => token(seq(
			'\\',
			choice(
				/[^xu\d]/,
				/\d{1,3}/,
				/x[\da-fA-F]{2}/,
				/u\{[\da-fA-F]+\}/,
			),
		)),

		number: $ => {
			const sign = choice('-', '+');
			const digits = /\d[_\d]*/;
			const exponent = seq(choice('e', 'E'), optional(sign), digits);
			const decimal_literal = seq(
				optional(sign),
				choice(
					digits,
					seq('.', digits),
					seq(digits, '.', optional(digits)),
				),
				optional(exponent),
			);

			const hex_digits = /[a-fA-F\d][_a-fA-F\d]*/;
			const hex_exponent = seq(choice('p', 'P'), optional(sign), hex_digits);
			const hexadecimal_literal = seq(
				optional(sign),
				choice('0x', '0X'),
				choice(
					hex_digits,
					seq('.', hex_digits),
					seq(hex_digits, '.', optional(hex_digits)),
				),
				optional(hex_exponent),
			);

			const special = choice('inf', 'nan');
			const special_literal = seq(
				optional(sign),
				'.',
				special,
			);

			return prec(PREC_IMPORTANT, token(choice(
				decimal_literal,
				hexadecimal_literal,
				special_literal,
			)));
		},

		multi_symbol: $ => seq(
			field('base', alias($.symbol, $.symbol_fragment)),
			repeat1(seq(
				token.immediate('.'),
				field('member', $._multi_symbol_fragment),
			)),
		),

		multi_symbol_method: $ => seq(
			field('base', choice(
				alias($.symbol, $.symbol_fragment),
				$.multi_symbol,
			)),
			token.immediate(':'),
			field('method', $._multi_symbol_fragment),
		),

		symbol_option: $ => /&[^(){}\[\]"'~;,@`.:\s]*/,
		symbol: $ => /[^#(){}\[\]"'~;,@`.:\s][^(){}\[\]"'~;,@`.:\s]*/,

		_symbol_with_trailing_dot: $ => alias(seq($.symbol, token.immediate('.')), $.symbol),

		_multi_symbol_fragment: $ => alias(token.immediate(/[^(){}\[\]"'~;,@`.:\s]+/), $.symbol_fragment),

		_special_override_symbol: $ => alias(
			prec(PREC_LAST_RESORT, choice(...SPECIAL_STANDALONE_SYMBOLS)),
			$.symbol
		),

		quote_reader_macro: $ => prec(-1, seq(
			field('macro', alias($._quote_reader_macro_char, '\'')),
			field('expression', $._quoted_sexp),
		)),
		quasi_quote_reader_macro: $ => prec(-1, seq(
			field('macro', alias($._quasi_quote_reader_macro_char, '`')),
			field('expression', $._quoted_sexp),
		)),
	},
});
