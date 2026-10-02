const {
	item,
	form,
	sequence,
} = require('../../grammar-lib/dsl.js');

const rules = {};
const forms = {};

rules['_function_identifier'] = $ => choice(
	$.symbol,
	$._symbol_with_trailing_dot,
	$.multi_symbol,
	$.multi_symbol_method,
);

// The reader doesn't enforce "& must be last" — that's a compiler-level
// check (see test/failures.fnl's "expected rest argument before last
// parameter", only reachable if this parses in the first place). So rest
// markers/varargs are allowed interspersed with ordinary parameters,
// deferring validity to the compiler like everywhere else in this file.
rules['sequence_arguments'] = $ => sequence(
	repeat(choice(
		item($._binding),
		item($.rest_binding),
		item(alias('...', $.symbol_binding)),
	)),
);

// Structurally identical to a plain `table`: a separately-defined
// table_metadata rule (with its own docstring/arglist/generic pair
// sub-rules) can't be reliably disambiguated from a plain `table` used as
// the function's actual return value without unbounded lookahead — the
// parser commits to the metadata-shaped path as soon as it sees the first
// pair and has no way back if nothing metadata-relevant turns out to
// follow (e.g. `(fn f [] {:a 1})` with the table as the sole return
// value). Reusing `table`'s own rule via alias means there's exactly one
// parse path for `{...}`, and "is this metadata or the return value"
// becomes an ordinary choice resolved only *after* the table is fully
// parsed. The cost: metadata pairs surface as plain `table_pair` nodes,
// not typed docstring/arglist fields — tooling that wants metadata
// semantics should inspect a pair's string key content
// (":fnl/docstring", ":fnl/arglist") directly instead.
rules['_function_inner_body_all'] = $ => seq(
	field('docstring', alias($.string, $.docstring)),
	field('metadata', alias($.table, $.table_metadata)),
	repeat1(item($._sexp)),
);
rules['_function_inner_body_docstring'] = $ => seq(
	field('docstring', alias($.string, $.docstring)),
	repeat1(item($._sexp)),
);
rules['_function_inner_body_metadata'] = $ => seq(
	field('metadata', alias($.table, $.table_metadata)),
	repeat1(item($._sexp)),
);
rules['_function_inner_body_generic'] = $ => prec(1, repeat1(item($._sexp)));

rules['_function_inner_body'] = $ => choice(
	$._function_inner_body_all,
	$._function_inner_body_docstring,
	$._function_inner_body_metadata,
	$._function_inner_body_generic,
);

rules['_function_body'] = $ => seq(
	optional(field('name', $._function_identifier)),
	field('args', $.sequence_arguments),
	optional($._function_inner_body),
);

[
	'fn',
	'lambda',
	'macro'
].forEach(name => forms[name] = $ => form($,
	name == 'lambda' ? choice(name, 'λ') : name,
	$._function_body,
));

// TODO: Move to simple-scope.js
forms['hashfn'] = $ => form($,
	'hashfn',
	item($._sexp),
);

module.exports = {
	rules,
	forms,

	// The metadata field now reuses table's own rule (see comment above),
	// so a trailing `{...}` is genuinely ambiguous between "this is the
	// metadata field" and "this is just the next body sexp" until the
	// parser sees what (if anything) follows it. Let GLR try both and keep
	// whichever completes.
	conflicts: $ => [
		[$._sexp, $._function_inner_body_metadata],
		[$._sexp, $._function_inner_body_all],
	],
};
