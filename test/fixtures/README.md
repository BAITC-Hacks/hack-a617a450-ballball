These three JSON files are copies of the user-supplied authenticated EKT
response bodies in `.ekt-inspection/`, inspected on 2026-09-23. They contain
product data only, with no credentials or request headers. They are historical
test data, not current prices or stock, and are never imported by production code.

All 40 catalog items have empty offers. Only one detail response is available.
Do not infer offer schemas, certificates, or universal property keys from these
samples. Mutated fixtures in tests are synthetic validation cases, not additional
observed API behavior.

`end-page-752.json` and `end-page-753.json` were captured from real authenticated
EKT requests on 2026-09-23 during full-catalog verification. Page 752 contains 17
products; page 753 has 20 products matching page 1, despite echoing page 753. This
is the observed short-final-page wraparound, not a fabricated empty-page response.
A compact boundary test replays the actual items/counts under three consecutive
page numbers; it does not assert that the full live catalog has only 37 products.
