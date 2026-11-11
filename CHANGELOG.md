# Changelog

## [Unreleased]

## [0.12.4] - 2026-11-12

### Fixed

- A translated line that finished a few milliseconds before the late-translation debounce timer expired was written as an extra transcript notify row even though the still-repainting translation box showed it; every finished line now gets its own full debounce window, and only lines the box never drew are sent as notify rows.

## [0.12.3] - 2026-11-12

### Changed

- The package is now an omomp release member: merges to `main` no longer bump the version, a scheduled run publishes `## [Unreleased]` to the `release` branch, tag and GitHub Release every day at 02:00 GMT+9, and installs use `#release`.
