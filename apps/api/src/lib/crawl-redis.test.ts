import { generateURLPermutations } from "./url-permutations";

describe("generateURLPermutations", () => {
  const expected = new Set(
    ["http", "https"].flatMap(protocol =>
      ["firecrawl.dev", "www.firecrawl.dev"].flatMap(host =>
        ["/", "/index.html", "/index.php"].map(
          path => `${protocol}://${host}${path}`,
        ),
      ),
    ),
  );

  it.each([
    "https://firecrawl.dev",
    "http://firecrawl.dev",
    "https://www.firecrawl.dev",
    "http://www.firecrawl.dev",
  ])("generates the canonical permutation set for %s", input => {
    const permutations = new Set(
      generateURLPermutations(input).map(url => url.href),
    );

    expect(permutations).toEqual(expected);
  });
});
