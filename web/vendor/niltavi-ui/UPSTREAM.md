# Niltavi UI product shell

The `4b7f51af84c60c455920363a841fb586ff224adc` revision supplies the shared header, footer, email and password form, theme helper, styles, tokens and font. Identity supplies its existing project symbol, routes and localized labels. [Pinned UI source](https://github.com/niltavi/niltavi-ui/tree/4b7f51af84c60c455920363a841fb586ff224adc/src)

The copies under `product/` and `theme/` match the pinned Git blobs. Identity keeps the pre-rendered authentication routes free of credential fields. The shared form uses POST and waits for hydration. An outer disabled fieldset waits for Identity's real configuration before enabling submission.

The web build resolves the header's icon imports through the matching Gravity UI package subpaths to avoid scanning the full icon catalog on Windows.
