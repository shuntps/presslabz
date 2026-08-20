# Fonts shipped with PressLabz

Three families travel with the product, self-hosted. A content manager that
fetches its type from a font CDN on every admin page load has handed away the
thing it was built to keep, so these are files in the repository — and files in
a repository are somebody else's work under somebody else's licence, which this
file exists to state precisely.

All three are licensed under the **SIL Open Font License, Version 1.1**. The
full text of each licence, taken from the same upstream pin as the font, is
beside this file. The licence permits redistribution — including inside a
product under a different licence — provided the copyright notice and the
licence travel with the font, which is what this directory does.

Each file here is a **subset**: the characters the interface and the default
theme actually draw, which is Latin, the French diacritics, typographic
punctuation and a handful of marks used as icons. A subset is a *Modified
Version* in the licence's terms, and that has consequences recorded below.

`pnpm --filter @presslabz/tokens fonts:build` reproduces all three from the
pins in this table. The build verifies the SHA-256 of every upstream file
before touching it, so a pin that moved is an error rather than a surprise.

## What ships

| File | Family | Upstream | Pinned at | Version | Upstream SHA-256 |
|---|---|---|---|---|---|
| `Archivo.woff2` | Archivo | [Omnibus-Type/Archivo](https://github.com/Omnibus-Type/Archivo) | commit `b5d63988ce19d044d3e10362de730af00526b672` | 2.001 | `664bbeb10522dac35c174a3860aaecad7b1ad3a0fc8b0d26888e26c824ec556d` |
| `JetBrainsMono.woff2` | JetBrains Mono | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) | tag `v2.304` | 2.304 | `662a196d58f1183bf2d77428b6d5283fe3f45161ab021bea4036bc98e5cac016` |
| `PressLabzSerif.woff2` | PressLabz Serif | [adobe-fonts/source-serif](https://github.com/adobe-fonts/source-serif) | tag `4.004R` | 4.004 | `38e35c59990b5a39ffb9fb841dfa6f5d2a80ce2c5ea004c3e433b1efd83ebbd0` |

Copyright notices, as the fonts themselves declare them:

- `Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)`
- `Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)`
- `© 2014 - 2021 Adobe Systems Incorporated (http://www.adobe.com/), with Reserved Font Name ‘Source’.`

## Reserved Font Names

Archivo and JetBrains Mono declare **no** Reserved Font Name; their copyright
lines carry none, and neither does the licence text beside them. A subset of
either may keep its name.

Source Serif is different, and it is the reason the third file is called what
it is. Its copyright reserves the name **“Source”**, and clause 3 of the OFL
says:

> No Modified Version of the Font Software may use the Reserved Font Name(s)
> unless explicit written permission is granted by the corresponding Copyright
> Holder. This restriction only applies to the primary font name as presented
> to the users.

A subset is a Modified Version. What ships is therefore Adobe's unmodified
outlines under a name of ours: the family is **PressLabz Serif**, in the font's
own name table and in `fonts.css`, and the PostScript name is
`PressLabzSerif-Regular`. Adobe's copyright notice stays in the file, as the
licence requires — the rename is about the *name presented to users*, not about
authorship, which remains theirs.

Nothing else about the outlines is changed. What is removed is glyphs.

## Why these three

The family names in `tokens.css` are **roles**, not typefaces —
`--pl-font-machine`, `--pl-font-content`, `--pl-font-data` — so a theme
overrides the value rather than learning what we happened to pick, and a
replacement is one token away.

All three are variable fonts, which is what makes one file per family enough
for every weight the interface uses, and in Archivo's case every width too.
