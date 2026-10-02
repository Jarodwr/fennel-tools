const {
	item,
	call,
	kv_pair,
	pair,
	list,
	sequence,
	table,
} = require('../grammar-lib/dsl.js');
const {
	PREC_SCENARIO_SPECIFIC,
    PREC_PRIORITY,
} = require('../grammar-lib/prec.js');

module.exports = {
	inline: $ => [
		$._symbol_binding,
		$._string_binding,
		$._number_binding,
		$._boolean_binding,
		$._nil_binding,
	],

	// An empty `[]`/`{}` is ambiguous between an empty binding pattern
	// (e.g. `(each [x []] ...)`'s trailing `[]` iterator vs. another
	// zero-item binding) and the corresponding empty literal `sequence`.
	// Resolving this needs lookahead past a single token, so let the GLR
	// runtime try both instead of picking one at generation time.
	conflicts: $ => [
		[$.sequence_binding, $.sequence],
	],

	rules: {
		_binding: $ => prec(PREC_SCENARIO_SPECIFIC, choice(
			$._reader_macro,
			$._symbol_binding,
			$.multi_symbol,
			$.multi_symbol_method,
			$._quoting_macro,
			$.pin_binding,
			$.legacy_guard_binding,
			$.list_binding,
			$.sequence_binding,
			$.table_binding,
			$._literal_binding,
		)),

		_quoting_macro: $ => prec(PREC_PRIORITY, choice(
			$.quote_form,
			$.unquote_form,
		)),

		_symbol_binding: $ => alias($.symbol, $.symbol_binding),

		list_binding: $ => list(
			repeat1(item($._binding))
		),

		// `(= binding-name)`: "pins" a pattern against an existing outer
		// binding of the same name, e.g. `(where [(= x)]) ...`. Only valid
		// inside a `(where)` guard per the reference, but that constraint
		// isn't enforced here — same policy as the rest of this file.
		pin_binding: $ => list(
			call(alias('=', $.symbol)),
			field('target', $._sexp),
		),

		// `(target ? guard...)`: the "legacy" match guard shape, e.g.
		// `(tbl ? tbl.sieze tbl.no)` — target is the actual binding, and
		// everything after the literal `?` is an arbitrary guard
		// expression, not a nested pattern. Only valid in `match`, per the
		// compiler's `:legacy-guard-allowed?`, but again not enforced here.
		legacy_guard_binding: $ => list(
			field('target', $._binding),
			alias('?', $.symbol_option),
			repeat1(field('guard', $._sexp)),
		),

		rest_binding: $ => pair($,
			{ lhs: alias('&', $.symbol_option) },
			{ rhs: $._binding },
		),

		// Captures the whole table/sequence being destructured under an
		// additional name, e.g. `{:a a :b b &as all}` or `[a b & c &as t]`.
		// Always binds a plain name, never a nested pattern.
		as_binding: $ => pair($,
			{ lhs: alias('&as', $.symbol_option) },
			{ rhs: $._symbol_binding },
		),

		// The reader doesn't enforce "&/&as must be last" or "at most one
		// of each" — those are compiler-level checks (see e.g.
		// test/failures.fnl's "&as argument before last parameter" and
		// "expected rest argument before last parameter" cases, which are
		// only reachable if this parses in the first place). So this
		// allows rest/as markers interspersed with ordinary bindings in
		// any order/count, deferring validity to the compiler like
		// everywhere else in this file.
		sequence_binding: $ => sequence(
			repeat(choice(
				item($._binding),
				item($.rest_binding),
				item($.as_binding),
			)),
		),

		_table_binding_key: $ => prec(PREC_SCENARIO_SPECIFIC, choice(
			alias(':', $.symbol_binding),
			$._string_binding,
			$.symbol_option,
			$.number,
			// A non-literal key (e.g. `(+ 1 1)`) is a compile-time error
			// ("expected key to be a literal"), not a syntax error.
			$.list,
		)),

		table_binding_pair: $ => kv_pair($, { key: $._table_binding_key }, { value: $._binding }),

		table_binding: $ => table(
			repeat(item($.table_binding_pair)),
			optional(item($.as_binding)),
		),

		binding_pair: $ => pair($, { lhs: $._binding }, { rhs: $._sexp }),

		_literal_binding: $ => choice(
			$._string_binding,
			$._number_binding,
			$._boolean_binding,
			$._nil_binding,
		),
		_string_binding: $ => alias($.string, $.string_binding),
		_number_binding: $ => alias($.number, $.number_binding),
		_boolean_binding: $ => alias($.boolean, $.boolean_binding),
		_nil_binding: $ => alias($.nil, $.nil_binding),
	}
};
