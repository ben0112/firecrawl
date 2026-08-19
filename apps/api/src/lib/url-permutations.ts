// For this function and the infrastructure surrounding it to work correctly,
// every valid URL must have a stable, non-empty permutation set. Two
// significantly different URLs must not share a permutation.
export function generateURLPermutations(url: string | URL): URL[] {
  const urlO = new URL(url);

  const urlWithWWW = new URL(urlO);
  const urlWithoutWWW = new URL(urlO);
  if (urlO.hostname.startsWith("www.")) {
    urlWithoutWWW.hostname = urlWithWWW.hostname.slice(4);
  } else {
    urlWithWWW.hostname = "www." + urlWithoutWWW.hostname;
  }

  let permutations = [urlWithWWW, urlWithoutWWW];

  permutations = permutations.flatMap(urlO => {
    if (!["http:", "https:"].includes(urlO.protocol)) {
      return [urlO];
    }

    const urlWithHTTP = new URL(urlO);
    const urlWithHTTPS = new URL(urlO);
    urlWithHTTP.protocol = "http:";
    urlWithHTTPS.protocol = "https:";

    return [urlWithHTTP, urlWithHTTPS];
  });

  permutations = permutations.flatMap(urlO => {
    const urlWithHTML = new URL(urlO);
    const urlWithPHP = new URL(urlO);
    const urlWithBare = new URL(urlO);
    const urlWithSlash = new URL(urlO);

    if (urlO.pathname.endsWith("/")) {
      urlWithBare.pathname =
        urlWithBare.pathname.length === 1
          ? urlWithBare.pathname
          : urlWithBare.pathname.slice(0, -1);
      urlWithHTML.pathname += "index.html";
      urlWithPHP.pathname += "index.php";
    } else if (urlO.pathname.endsWith("/index.html")) {
      urlWithPHP.pathname =
        urlWithPHP.pathname.slice(0, -"index.html".length) + "index.php";
      urlWithSlash.pathname = urlWithSlash.pathname.slice(
        0,
        -"index.html".length,
      );
      urlWithBare.pathname = urlWithBare.pathname.slice(
        0,
        -"/index.html".length,
      );
    } else if (urlO.pathname.endsWith("/index.php")) {
      urlWithHTML.pathname =
        urlWithHTML.pathname.slice(0, -"index.php".length) + "index.html";
      urlWithSlash.pathname = urlWithSlash.pathname.slice(
        0,
        -"index.php".length,
      );
      urlWithBare.pathname = urlWithBare.pathname.slice(
        0,
        -"/index.php".length,
      );
    } else {
      urlWithSlash.pathname += "/";
      urlWithHTML.pathname += "/index.html";
      urlWithPHP.pathname += "/index.php";
    }

    return [urlWithHTML, urlWithPHP, urlWithSlash, urlWithBare];
  });

  return [...new Set(permutations.map(x => x.href))].map(x => new URL(x));
}
