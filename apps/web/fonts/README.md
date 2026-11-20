# Fonts

## InterVariable.woff2

Inter, by Rasmus Andersson. Variable weight axis, WOFF2.
Source: https://github.com/rsms/inter (v4.1)
Licence: SIL Open Font Licence 1.1 - see `Inter-LICENSE.txt`.

### Why the file is committed rather than fetched

`next/font/google` resolves the font **at build time**. The Docker image is
built without any guarantee that fonts.googleapis.com is reachable, and if it
is not, `next build` does not degrade - it fails. That turns a cosmetic
dependency into a broken `docker compose up` on the reviewer's machine, which
is exactly the failure risk R-05 exists to prevent.

`next/font/local` reads this file from disk. No network at build time, none at
runtime, and the rendered result is identical on every machine - which also
means the screenshots in the test matrix are reproducible.

The cost is 352 KB in the repository, carried once and cached by the browser
indefinitely. A system font stack would cost nothing, but renders differently
on every operating system.
