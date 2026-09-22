# KeilHQ Brand Fonts

This directory hosts local web font files embedded in templates via `@font-face`.
Per `spec.md` §7.2, templates use local font files rather than external CDN or network requests to guarantee deterministic, offline rendering inside headless Chromium.

## Expected Font Files

Place the following font files (WOFF2 or TTF format) into this directory:

### 1. Headline Font: DM Sans
- `DMSans-Regular.woff2` (or `.ttf`) — 400 weight
- `DMSans-Medium.woff2` (or `.ttf`) — 500 weight
- `DMSans-Bold.woff2` (or `.ttf`) — 700 weight

### 2. Body Font: Inter
- `Inter-Regular.woff2` (or `.ttf`) — 400 weight
- `Inter-Medium.woff2` (or `.ttf`) — 500 weight
- `Inter-SemiBold.woff2` (or `.ttf`) — 600 weight

### 3. Indic / Multilingual Fallback: Noto Sans
- `NotoSans-Regular.ttf`
- `NotoSans-Bold.ttf`

## Graceful Fallback
If any font file is not present locally, template styles automatically fall back to:
```css
font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans', sans-serif;
```
This ensures local development and automated CI testing succeed even before the licensed/custom font binaries are placed into this folder.
