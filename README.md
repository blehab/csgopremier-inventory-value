# CSGOPremier Inventory Value

A Chrome extension that adds quality-of-life features to [csgopremier.com](https://csgopremier.com).
It is a plain MV3 extension with no build step and no dependencies — the `.js` files here are both
the source and what ships.

It declares no permissions and no host permissions, uses no `chrome.*` APIs, and makes no
cross-origin requests: every fetch is same-origin to `csgopremier.com`, using the session you are
already signed in with.

## Features

| Module | What it adds |
| --- | --- |
| `content.js` | A "Get my inventory value" button, totalling the inventory from `/api/inventory` instead of scrolling the lazily-rendered grid |
| `sell-diff.js` | How much lower (or higher) the "Sell to Market" quote is than the item's listed price |
| `custom-sorts.js` | `Price` and `Float` options in the inventory sort dropdown |
| `sellable-tab.js` | A "Sellable" tab showing only items the context menu offers "Sell to Market" for |
| `range-filters.js` | Float and price min/max range filters for the inventory |
| `pattern-data.js`, `badges-core.js`, `card-badges.js` | Float and pattern badges on inventory cards, market listings and case reveals (every pattern list cites its source) |
| `market-filters.js` | Pattern ID and rare-item filters on the Market |
| `multi-open.js` | Opening several copies of the same case at once, with the animation for each |
| `bulk-menu.js` | Right-click actions across several selected inventory items |
| `case-shop.js` | A "Cases" sidebar entry and a price sort in the case shop |
| `crate-received.js` | Replaces the "Case unlocked!" modal with a corner toast |
| `tradeup-sort.js` | A price sort on the Trade-Up page |
| `ready-check.js` | A less obstructive match ready check, showing who hasn't accepted yet |
| `auto-accept.js` | Optional auto-accept of the match-found dialog (off by default) |
| `overwatch-info.js` | Match details above the clip on the Overwatch review page |
| `overwatch-resume.js` | Keeps Overwatch watch progress across the page's focus-triggered reloads |

Settings live in the page's own `localStorage` under the `cip-` prefix, so they belong to the
`csgopremier.com` origin and survive updating or reinstalling the extension.

## Install

1. Download **`csgopremier-inventory-value.zip`** and **`update.bat`** from the
   [latest release](https://github.com/blehab/csgopremier-inventory-value/releases/latest).
2. Extract the zip into a folder you intend to keep, and put `update.bat` in that same folder.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the
   folder.

## Update

Double-click **`update.bat`**. It downloads the latest release, replaces the extension's files in
place, and tells you the version it went from and to. Then open `chrome://extensions` and press the
**reload arrow** on the extension's card — Chrome keeps running the old copy until you do.

`update.bat` updates the folder it sits in; pass a path as the first argument to update a folder
somewhere else. It only overwrites files that are in the release, so anything else in the folder is
left alone — including `update.bat` itself, which is why the script is published as its own release
asset rather than being packed inside the zip.

## Release

1. Bump `"version"` in `manifest.json` and commit it.
2. Tag and push:
   ```
   git tag v1.43.1
   git push origin main --tags
   ```

[`.github/workflows/release.yml`](.github/workflows/release.yml) then checks the tag matches the
manifest version, packs `manifest.json` + the `.js` files + this README into
`csgopremier-inventory-value.zip`, verifies every script the manifest declares is actually in the
archive, and publishes the zip and `update.bat` as release assets. Follow it with `gh run watch`.

The zip's name has no version in it on purpose: that keeps
`releases/latest/download/csgopremier-inventory-value.zip` a permanent URL for `update.bat` to pull.
