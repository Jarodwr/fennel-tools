# Macro Hooks

Fennel macros are opaque to the language server — it cannot see inside them to know what names they bind, what sub-forms are functions, or what scopes they open. Macro hooks let you teach the LSP about a macro's semantics so completions, definitions, and diagnostics work correctly at call sites.

---

## Configuration

Hooks are registered in `.lsp.fnl` under the `:macro-hooks` key. Each hook is a Fennel function that receives the call node and returns a list of instructions.

```fennel
;; .lsp.fnl
{:macro-hooks
  {:my-macro (fn [call] [...instructions...])}}
```

---

## The Call Node

The hook receives one argument: the macro call as a tree of nodes. Each node has:

| Field        | Type            | Description                          |
|--------------|-----------------|--------------------------------------|
| `kind`       | string          | `"list"`, `"symbol"`, `"string"`, `"number"`, `"keyword"`, `"bool"`, `"vararg"` |
| `value`      | string or nil   | Token text for leaf nodes            |
| `children`   | table or nil    | Child nodes for list nodes           |
| `span`       | `{start end}`   | Byte offsets in the source file      |

For a call `(defnode Foo (fn _ready [self] ...))`:
- `call.children[1]` → symbol `defnode`
- `call.children[2]` → symbol `Foo`
- `call.children[3]` → list `(fn _ready [self] ...)`

---

## Instructions

A hook returns a list (table) of instruction tables. Return an empty list `[]` to suppress the default macro-body analysis without doing anything.

### `:bind` — introduce a name into scope

```fennel
{:type :bind :name "Foo" :span call.children[2].span}
```

Creates a local definition at the given span. The name becomes visible to completions, `goto-definition`, and references.

### `:analyze` — analyze a sub-form normally

```fennel
{:type :analyze :index 3}
```

Runs the standard analyzer on `call.children[index]`. Use this for sub-forms that are plain expressions — the analyzer will resolve identifiers and collect definitions from them.

`:path` reaches a node at any depth, 1-based at each level, in place of `:index`:

```fennel
{:type :analyze :path [5 3 2]}   ; call.children[5].children[3].children[2]
```

A DSL often nests: a default inside `(group G (prop p default))` is at `[i 3 3]`. A path that doesn't lead to a node is ignored.

### `:analyze-fn` — analyze a sub-form as a function body

```fennel
{:type :analyze-fn :index 3}
```

Like `:analyze`, but treats the sub-form as a `fn` form. Parameters are bound into scope, the body is analyzed, and any nested `fn` definitions are collected as real symbols. Use this when a sub-form has the shape `(fn name [params] body...)`. The head symbol isn't checked, so `(method name [params] body...)` works too. It takes `:path` as `:analyze` does.

`:implicit-params` binds names the form doesn't write as parameters of the function, such as a method's `self`:

```fennel
{:type :analyze-fn :path [4] :implicit-params ["self"]}
```

References to them resolve, and they're never reported as unused. Go-to-definition on one goes to the form's head.

### `:skip` — leave a node unanalyzed

```fennel
{:type :skip :span node.span}
```

A later `:analyze` or `:analyze-fn` that reaches the node at that span doesn't analyze it or anything inside it. Use it for a DSL name inside an analyzed body, such as the method name in `(super take damage)`, which isn't a variable. Skips must come before the instruction that reaches the node.

### `:scope-open` / `:scope-close` — bracket a new scope

```fennel
{:type :scope-open}
{:type :scope-close}
```

Any `:bind` or `:analyze` instructions between these two see each other but are hidden from the outer scope. Useful when a macro creates an isolated block.

---

## Example — `defnode`

`defnode` binds a class name and treats each `(fn ...)` sub-form as a real function:

```fennel
;; in hooks-macro.fnl
(import-macros {: defnode} :simple-macros)

(defnode FennelNode3D
  (fn _ready [self] ...)
  (fn _process [self delta] ...))
```

Hook:

```fennel
{:macro-hooks
  {:defnode
    (fn [call]
      (let [result []
            name-node (. call.children 2)]
        ;; Bind the class name
        (table.insert result {:type :bind
                              :name name-node.value
                              :span name-node.span})
        ;; Analyze each (fn ...) sub-form as a real function
        (for [i 3 (length call.children)]
          (let [form (. call.children i)
                head (and form.children (. form.children 1))]
            (when (and head (= head.value :fn))
              (table.insert result {:type :analyze-fn :index i}))))
        result))}}
```

After this hook runs:
- `FennelNode3D` appears in `workspace/symbol` and goto-definition works on it
- `_ready` and `_process` appear as function symbols with correct parameter lists

---

## Module-qualified keys

If two macro modules export the same name, use a nested table keyed by module path to avoid collisions. Module-specific hooks take priority; the flat key acts as a fallback for any module.

```fennel
{:macro-hooks
  {;; applies to defnode from any module
   :defnode flat-hook
   ;; overrides the flat hook for defnode from this specific module
   "my-project.macros" {:defnode specific-hook}}}
```

The module key matches the string passed to `import-macros`:

```fennel
(import-macros {: defnode} :my-project.macros)
;;                          ^^^^^^^^^^^^^^^^^ this string
```

---

## Global macros

A macro the compiler provides to every file, with no `import-macros`, is declared under `:global-macros`, with its hook (or `true` for none):

```fennel
{:global-macros {:defnode defnode-hook :deftool defnode-hook}}
```

---

## Shipping hooks with a library

`.lsp.fnl` can `require` modules from the workspace root, as `.fnl` or `.fnlm` files. A library can ship its settings and hooks as one module, and a project's `.lsp.fnl` is then a single line:

```fennel
(require :addons.my_lib.lsp)   ; addons/my_lib/lsp.fnl or lsp.fnlm
```

`.fnlm` suits a host that would load a `.fnl` file as code, such as a Godot addon.

---

## Checking from the command line

`fennel-ls check FILE…` applies the nearest `.lsp.fnl` (in the file's directory or an ancestor): its platform, `:known-globals`, `:global-docs`, `:global-macros` and hooks. It prints the same warnings the server publishes.

---

## Warn on unhooked macros

To get a hint-level diagnostic on every macro call that has no registered hook:

```fennel
;; .lsp.fnl
{:warn-unhooked-macros true
 :macro-hooks {...}}
```

This is off by default. When enabled, each unhooked macro call produces a diagnostic with severity **Hint**, so it is visible but non-intrusive.
