# Departure Mono

Bundled, not fetched: extension pages cannot load remote fonts under the MV3
content security policy, and the UI must render identically offline.

- Font: Departure Mono v1.500 by Helena Zhang — https://departuremono.com
- Source: https://github.com/rektdeckard/departure-mono/releases/tag/v1.500
- License: SIL Open Font License 1.1 (see LICENSE-DepartureMono.txt, which the
  OFL requires be redistributed alongside the font)

Two properties drive the whole stylesheet:

1. **Set font sizes in increments of 11px.** Anything else lands off the pixel
   grid and renders blurry. The type scale is therefore 11px and 22px only —
   hierarchy comes from colour, case and spacing rather than size.
2. **There is exactly one weight.** `font-weight: 600` would synthesise a fake
   bold and smear the pixels, so no rule in popup.css sets a weight.
