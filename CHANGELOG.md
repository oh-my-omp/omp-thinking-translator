# Changelog

## [Unreleased]

### Changed

- Updated the shared copy of `i18n.ts` to oh-my-omp/shared@33dbe00.

### Fixed

- A config file that parses as JSON but has an invalid field (for example `"enabled": "yes"`) no longer repeats its "config invalid, translation disabled" warning on every message; the warning appears once per path until that path loads successfully again.

## [0.12.4] - 2026-11-12

### Fixed

- A translated line that finished a few milliseconds before the late-translation debounce timer expired was written as an extra transcript notify row even though the still-repainting translation box showed it; every finished line now gets its own full debounce window, and only lines the box never drew are sent as notify rows.

## [0.12.3] - 2026-11-12

### Changed

- The package is now an omomp release member: merges to `main` no longer bump the version, a scheduled run publishes `## [Unreleased]` to the `release` branch, tag and GitHub Release every day at 02:00 GMT+9, and installs use `#release`.
