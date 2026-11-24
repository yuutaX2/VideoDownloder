/*
 * 画像検索ソース定義
 *
 * 各ソースは共通インターフェースを持つ:
 *   search({ query, page, orientation, commercial, keys }) -> Promise<{ items, hasMore }>
 *
 * items は正規化された画像オブジェクト:
 *   { id, source, title, thumb, full, pageUrl, width, height, author, license }
 */
(function (global) {
  "use strict";

  const PER_PAGE = 20;

  async function getJSON(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function qs(params) {
    const sp = new URLSearchParams();
    Object.keys(params).forEach((k) => {
      const v = params[k];
      if (v !== undefined && v !== null && v !== "") sp.append(k, v);
    });
    return sp.toString();
  }

  function stripHtml(html) {
    if (!html) return "";
    const div = document.createElement("div");
    div.innerHTML = html;
    return (div.textContent || "").trim();
  }

  function orientationOf(w, h) {
    if (!w || !h) return null;
    const r = w / h;
    if (r > 1.15) return "landscape";
    if (r < 0.87) return "portrait";
    return "square";
  }

  /** 縦横比フィルタをサポートしないソース向けのクライアント側フィルタ */
  function filterOrientation(items, orientation) {
    if (!orientation) return items;
    return items.filter((it) => {
      const o = orientationOf(it.width, it.height);
      return o === null || o === orientation;
    });
  }

  // ------------------------------------------------------------------
  // Openverse (WordPress 財団) — 8億点以上のオープンライセンス画像
  // ------------------------------------------------------------------
  const openverse = {
    id: "openverse",
    name: "Openverse",
    description: "Flickr・Wikimedia・美術館など数十のサイトを横断する8億点以上のCC画像",
    homepage: "https://openverse.org/",
    defaultOn: true,
    async search({ query, page, orientation, commercial }) {
      const aspect = { landscape: "wide", portrait: "tall", square: "square" }[orientation];
      const url =
        "https://api.openverse.org/v1/images/?" +
        qs({
          q: query,
          page: page,
          page_size: PER_PAGE,
          aspect_ratio: aspect,
          license_type: commercial ? "commercial" : undefined,
        });
      const data = await getJSON(url);
      const items = (data.results || []).map((r) => ({
        id: "ov-" + r.id,
        source: "openverse",
        title: r.title || "",
        thumb: r.thumbnail || r.url,
        full: r.url,
        pageUrl: r.foreign_landing_url || "https://openverse.org/image/" + r.id,
        width: r.width,
        height: r.height,
        author: r.creator || "",
        license: r.license
          ? ("CC " + r.license.toUpperCase() + " " + (r.license_version || "")).replace("CC CC0", "CC0").replace("CC PDM", "Public Domain").trim()
          : "",
        via: r.provider || r.source || "",
      }));
      return { items, hasMore: page < (data.page_count || 0) };
    },
  };

  // ------------------------------------------------------------------
  // Wikimedia Commons — 1億点以上のフリー画像（日本語検索にも強い）
  // ------------------------------------------------------------------
  const wikimedia = {
    id: "wikimedia",
    name: "Wikimedia Commons",
    description: "Wikipediaの画像庫。写真・図版・地図・歴史資料など1億点以上",
    homepage: "https://commons.wikimedia.org/",
    defaultOn: true,
    async search({ query, page, orientation }) {
      const offset = (page - 1) * PER_PAGE;
      const url =
        "https://commons.wikimedia.org/w/api.php?" +
        qs({
          action: "query",
          format: "json",
          origin: "*",
          generator: "search",
          gsrsearch: "filetype:bitmap|drawing " + query,
          gsrnamespace: 6,
          gsrlimit: PER_PAGE,
          gsroffset: offset,
          prop: "imageinfo",
          iiprop: "url|size|extmetadata|mime",
          iiurlwidth: 480,
          iiextmetadatafilter: "Artist|LicenseShortName|ObjectName|ImageDescription",
        });
      const data = await getJSON(url);
      const pages = data.query && data.query.pages ? Object.values(data.query.pages) : [];
      pages.sort((a, b) => (a.index || 0) - (b.index || 0));
      let items = pages
        .filter((p) => p.imageinfo && p.imageinfo[0])
        .map((p) => {
          const ii = p.imageinfo[0];
          const meta = ii.extmetadata || {};
          const val = (k) => (meta[k] && meta[k].value) || "";
          return {
            id: "wm-" + p.pageid,
            source: "wikimedia",
            title: stripHtml(val("ObjectName")) || p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""),
            thumb: ii.thumburl || ii.url,
            full: ii.url,
            pageUrl: ii.descriptionurl,
            width: ii.width,
            height: ii.height,
            author: stripHtml(val("Artist")),
            license: stripHtml(val("LicenseShortName")),
          };
        });
      items = filterOrientation(items, orientation);
      return { items, hasMore: !!(data.continue && data.continue.gsroffset) };
    },
  };

  // ------------------------------------------------------------------
  // NASA Image and Video Library — 宇宙・天体・航空写真
  // ------------------------------------------------------------------
  const nasa = {
    id: "nasa",
    name: "NASA",
    description: "NASAの公式画像ライブラリ。宇宙・天体・ロケット・地球写真",
    homepage: "https://images.nasa.gov/",
    defaultOn: true,
    async search({ query, page, orientation }) {
      const url =
        "https://images-api.nasa.gov/search?" +
        qs({ q: query, media_type: "image", page: page, page_size: PER_PAGE });
      const data = await getJSON(url);
      const col = data.collection || {};
      const items = (col.items || [])
        .map((it) => {
          const d = (it.data && it.data[0]) || {};
          const links = it.links || [];
          const preview = links.find((l) => l.rel === "preview") || links[0];
          const canonical = links.find((l) => l.rel === "canonical");
          const large = links.find((l) => /~large\./.test(l.href || ""));
          if (!preview) return null;
          return {
            id: "nasa-" + d.nasa_id,
            source: "nasa",
            title: d.title || "",
            thumb: preview.href,
            full: (canonical || large || preview).href,
            pageUrl: "https://images.nasa.gov/details/" + encodeURIComponent(d.nasa_id),
            width: (canonical && canonical.width) || (preview && preview.width),
            height: (canonical && canonical.height) || (preview && preview.height),
            author: d.photographer || d.secondary_creator || d.center || "NASA",
            license: "Public Domain (NASA)",
          };
        })
        .filter(Boolean);
      const hasMore = (col.links || []).some((l) => l.rel === "next");
      return { items: filterOrientation(items, orientation), hasMore };
    },
  };

  // ------------------------------------------------------------------
  // シカゴ美術館 (Art Institute of Chicago)
  // ------------------------------------------------------------------
  const artic = {
    id: "artic",
    name: "シカゴ美術館",
    description: "シカゴ美術館の所蔵作品。絵画・浮世絵・写真・工芸",
    homepage: "https://www.artic.edu/collection",
    defaultOn: true,
    async search({ query, page, orientation, commercial }) {
      const params = {
        q: query,
        page: page,
        limit: PER_PAGE,
        fields: "id,title,image_id,artist_title,artist_display,is_public_domain,thumbnail",
      };
      if (commercial) params["query[term][is_public_domain]"] = "true";
      const url = "https://api.artic.edu/api/v1/artworks/search?" + qs(params);
      const data = await getJSON(url);
      const iiif = (data.config && data.config.iiif_url) || "https://www.artic.edu/iiif/2";
      const items = (data.data || [])
        .filter((a) => a.image_id)
        .map((a) => ({
          id: "artic-" + a.id,
          source: "artic",
          title: a.title || "",
          thumb: iiif + "/" + a.image_id + "/full/400,/0/default.jpg",
          full: iiif + "/" + a.image_id + "/full/843,/0/default.jpg",
          pageUrl: "https://www.artic.edu/artworks/" + a.id,
          width: a.thumbnail && a.thumbnail.width,
          height: a.thumbnail && a.thumbnail.height,
          author: a.artist_title || (a.artist_display || "").split("\n")[0],
          license: a.is_public_domain ? "Public Domain (CC0)" : "著作権あり・要確認",
        }));
      const pg = data.pagination || {};
      return { items: filterOrientation(items, orientation), hasMore: page < (pg.total_pages || 0) };
    },
  };

  // ------------------------------------------------------------------
  // メトロポリタン美術館 (The Met)
  // ------------------------------------------------------------------
  const metCache = new Map(); // query -> Promise<objectIDs[]>
  const met = {
    id: "met",
    name: "メトロポリタン美術館",
    description: "The Metのオープンアクセス作品（47万点以上）",
    homepage: "https://www.metmuseum.org/art/collection",
    defaultOn: false,
    async search({ query, page, orientation, commercial }) {
      const key = query + "|" + (commercial ? 1 : 0);
      if (!metCache.has(key)) {
        const url =
          "https://collectionapi.metmuseum.org/public/collection/v1/search?" +
          qs({ q: query, hasImages: "true", isPublicDomain: commercial ? "true" : undefined });
        metCache.set(
          key,
          getJSON(url).then((d) => d.objectIDs || []).catch((e) => {
            metCache.delete(key);
            throw e;
          })
        );
      }
      const ids = await metCache.get(key);
      const per = 12; // 1件ずつ詳細取得が必要なので控えめに
      const slice = ids.slice((page - 1) * per, page * per);
      const objs = await Promise.all(
        slice.map((id) =>
          getJSON("https://collectionapi.metmuseum.org/public/collection/v1/objects/" + id).catch(() => null)
        )
      );
      const items = objs
        .filter((o) => o && (o.primaryImageSmall || o.primaryImage))
        .map((o) => ({
          id: "met-" + o.objectID,
          source: "met",
          title: o.title || "",
          thumb: o.primaryImageSmall || o.primaryImage,
          full: o.primaryImage || o.primaryImageSmall,
          pageUrl: o.objectURL || "https://www.metmuseum.org/art/collection/search/" + o.objectID,
          author: o.artistDisplayName || o.culture || "",
          license: o.isPublicDomain ? "Public Domain (CC0)" : "著作権あり・要確認",
        }));
      return { items: filterOrientation(items, orientation), hasMore: page * per < ids.length };
    },
  };

  // ------------------------------------------------------------------
  // 以下は無料APIキーが必要なソース（設定画面で入力すると有効化）
  // ------------------------------------------------------------------
  const pixabay = {
    id: "pixabay",
    name: "Pixabay",
    description: "商用利用可の高品質写真・イラスト・ベクター（要APIキー・無料）",
    homepage: "https://pixabay.com/api/docs/",
    keyName: "pixabay",
    defaultOn: true,
    async search({ query, page, orientation, keys }) {
      const url =
        "https://pixabay.com/api/?" +
        qs({
          key: keys.pixabay,
          q: query.slice(0, 100),
          page: page,
          per_page: PER_PAGE,
          safesearch: "true",
          lang: /[぀-ヿ一-鿿]/.test(query) ? "ja" : undefined,
          orientation: { landscape: "horizontal", portrait: "vertical" }[orientation],
        });
      const data = await getJSON(url);
      let items = (data.hits || []).map((h) => ({
        id: "px-" + h.id,
        source: "pixabay",
        title: h.tags || "",
        thumb: h.webformatURL || h.previewURL,
        full: h.largeImageURL || h.webformatURL,
        pageUrl: h.pageURL,
        width: h.imageWidth,
        height: h.imageHeight,
        author: h.user || "",
        license: "Pixabay License（商用可）",
      }));
      if (orientation === "square") items = filterOrientation(items, orientation);
      return { items, hasMore: page * PER_PAGE < Math.min(data.totalHits || 0, 500) };
    },
  };

  const unsplash = {
    id: "unsplash",
    name: "Unsplash",
    description: "プロ写真家による高解像度フリー写真（要APIキー・無料）",
    homepage: "https://unsplash.com/developers",
    keyName: "unsplash",
    defaultOn: true,
    async search({ query, page, orientation, keys }) {
      const url =
        "https://api.unsplash.com/search/photos?" +
        qs({
          query: query,
          page: page,
          per_page: PER_PAGE,
          client_id: keys.unsplash,
          orientation: { landscape: "landscape", portrait: "portrait", square: "squarish" }[orientation],
        });
      const data = await getJSON(url, { headers: { "Accept-Version": "v1" } });
      const items = (data.results || []).map((p) => ({
        id: "us-" + p.id,
        source: "unsplash",
        title: p.description || p.alt_description || "",
        thumb: p.urls.small,
        full: p.urls.regular || p.urls.full,
        pageUrl: p.links.html + "?utm_source=image_search_app&utm_medium=referral",
        width: p.width,
        height: p.height,
        author: (p.user && p.user.name) || "",
        license: "Unsplash License（商用可）",
      }));
      return { items, hasMore: page < (data.total_pages || 0) };
    },
  };

  const pexels = {
    id: "pexels",
    name: "Pexels",
    description: "無料のストック写真（要APIキー・無料）",
    homepage: "https://www.pexels.com/api/",
    keyName: "pexels",
    defaultOn: true,
    async search({ query, page, orientation, keys }) {
      const url =
        "https://api.pexels.com/v1/search?" +
        qs({
          query: query,
          page: page,
          per_page: PER_PAGE,
          orientation: orientation || undefined,
          locale: /[぀-ヿ一-鿿]/.test(query) ? "ja-JP" : undefined,
        });
      const data = await getJSON(url, { headers: { Authorization: keys.pexels } });
      const items = (data.photos || []).map((p) => ({
        id: "pe-" + p.id,
        source: "pexels",
        title: p.alt || "",
        thumb: p.src.medium,
        full: p.src.large2x || p.src.original,
        pageUrl: p.url,
        width: p.width,
        height: p.height,
        author: p.photographer || "",
        license: "Pexels License（商用可）",
      }));
      return { items, hasMore: !!data.next_page };
    },
  };

  // ------------------------------------------------------------------
  // 外部の検索エンジン（Web全体の画像を探す用：新しいタブで開く）
  // ------------------------------------------------------------------
  const webEngines = [
    { name: "Google 画像", url: (q) => "https://www.google.com/search?tbm=isch&q=" + encodeURIComponent(q) },
    { name: "Bing 画像", url: (q) => "https://www.bing.com/images/search?q=" + encodeURIComponent(q) },
    { name: "Yahoo! JAPAN 画像", url: (q) => "https://search.yahoo.co.jp/image/search?p=" + encodeURIComponent(q) },
    { name: "DuckDuckGo", url: (q) => "https://duckduckgo.com/?ia=images&iax=images&q=" + encodeURIComponent(q) },
    { name: "Yandex", url: (q) => "https://yandex.com/images/search?text=" + encodeURIComponent(q) },
    { name: "Pinterest", url: (q) => "https://www.pinterest.jp/search/pins/?q=" + encodeURIComponent(q) },
    { name: "Flickr", url: (q) => "https://www.flickr.com/search/?text=" + encodeURIComponent(q) },
    { name: "pixiv", url: (q) => "https://www.pixiv.net/tags/" + encodeURIComponent(q) + "/illustrations" },
    { name: "いらすとや", url: (q) => "https://www.irasutoya.com/search?q=" + encodeURIComponent(q) },
    { name: "ColBase（国立博物館）", url: (q) => "https://colbase.nich.go.jp/?locale=ja&q=" + encodeURIComponent(q) },
  ];

  // ------------------------------------------------------------------
  // 画像で検索（逆画像検索）— 画像URLを各サービスに渡す
  // ------------------------------------------------------------------
  const reverseEngines = [
    { name: "Google レンズ", note: "総合・商品・場所", url: (u) => "https://lens.google.com/uploadbyurl?url=" + encodeURIComponent(u), upload: "https://lens.google.com/" },
    { name: "Bing ビジュアル検索", note: "総合", url: (u) => "https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&q=imgurl:" + encodeURIComponent(u), upload: "https://www.bing.com/visualsearch" },
    { name: "Yandex", note: "顔・人物・類似画像に強い", url: (u) => "https://yandex.com/images/search?rpt=imageview&url=" + encodeURIComponent(u), upload: "https://yandex.com/images/" },
    { name: "TinEye", note: "出典・初出の特定", url: (u) => "https://tineye.com/search?url=" + encodeURIComponent(u), upload: "https://tineye.com/" },
    { name: "SauceNAO", note: "イラスト・アニメ・漫画", url: (u) => "https://saucenao.com/search.php?url=" + encodeURIComponent(u), upload: "https://saucenao.com/" },
    { name: "ascii2d", note: "二次元イラスト", url: (u) => "https://ascii2d.net/search/url/" + encodeURIComponent(u), upload: "https://ascii2d.net/" },
  ];

  global.ImageSources = {
    PER_PAGE,
    list: [openverse, wikimedia, nasa, artic, met, pixabay, unsplash, pexels],
    webEngines,
    reverseEngines,
  };
})(window);
