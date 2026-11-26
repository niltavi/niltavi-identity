# Niltavi UI product shell

The `4b7f51af84c60c455920363a841fb586ff224adc` revision supplies the shared header, footer, email and password form, theme helper, styles, tokens and font. Identity supplies its existing project symbol, routes and localized labels. [Pinned UI source](https://github.com/niltavi/niltavi-ui/tree/4b7f51af84c60c455920363a841fb586ff224adc/src)

The copies under `product/` and `theme/` match the pinned Git blobs. Identity keeps the pre-rendered authentication routes free of credential fields. The shared form uses POST and waits for hydration. An outer disabled fieldset waits for Identity's real configuration before enabling submission.

The client build and pre-renderer resolve the header's icon imports through the matching Gravity UI package subpaths to avoid scanning the full icon catalog on Windows.

The adaptations under `templates/saas/` come from `5c1f2ead069b34bc1881ee4566e18a9273173b39`. Identity uses the flat AppSidebar and UserMenu with route links, localized actions, and the current account. [Navigation source](https://github.com/niltavi/niltavi-ui/blob/5c1f2ead069b34bc1881ee4566e18a9273173b39/src/templates/saas/Navigation.tsx) · [Sidebar and menu styles](https://github.com/niltavi/niltavi-ui/blob/5c1f2ead069b34bc1881ee4566e18a9273173b39/src/templates/scenarios.css)

The `vendor/niltavi-banner/screenprint.js` is vendored from [niltavi-banner](https://git.yarinz.com/niltavi/niltavi-banner) at commit `a0d8d9f` (MIT-licensed). It provides the generative poster for the auth layout's brand panel.
