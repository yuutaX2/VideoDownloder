(function () {
  "use strict";

  const { list: SOURCES, webEngines, reverseEngines } = window.ImageSources;
  const $ = (id) => document.getElementById(id);

  // ---------------- 永続化（失敗しても動くように） ----------------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem("wis:" + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem("wis:" + key, JSON.stringify(value));
      } catch (e) {
        /* noop */
      }
    },
  };

  // ---------------- 状態 ----------------
  const state = {
    query: "",
    keys: store.get("keys", {}),
    enabled: store.get("enabled", null),
    perSource: {}, // id -> { page, hasMore, count, error }
    items: [],
    seen: new Set(),
    loading: false,
    generation: 0,
    lbIndex: -1,
  };
  if (!state.enabled) {
    state.enabled = {};
    SOURCES.forEach((s) => (state.enabled[s.id] = s.defaultOn));
  }

  const isAvailable = (s) => !s.keyName || !!state.keys[s.keyName];
  const activeSources = () => SOURCES.filter((s) => state.enabled[s.id] && isAvailable(s));

  // ---------------- テーマ ----------------
  const savedTheme = store.get("theme", null);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("themeBtn").addEventListener("click", () => {
    const cur =
      document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
  });

  // ---------------- タブ ----------------
  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on);
    });
    $("panel-keyword").hidden = name !== "keyword";
    $("panel-reverse").hidden = name !== "reverse";
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

  // ---------------- トースト ----------------
  let toastTimer;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2200);
  }

  // ---------------- ソースチップ ----------------
  function renderChips() {
    const wrap = $("sourceChips");
    wrap.innerHTML = "";
    SOURCES.forEach((s) => {
      const avail = isAvailable(s);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (state.enabled[s.id] && avail ? " on" : "") + (avail ? "" : " locked");
      chip.title = s.description + (avail ? "" : "\n（設定でAPIキーを登録すると使えます）");
      const ps = state.perSource[s.id];
      let extra = "";
      if (!avail) extra = '<span class="count">🔒</span>';
      else if (ps && ps.error) extra = '<span class="err">エラー</span>';
      else if (ps && state.enabled[s.id]) extra = '<span class="count">' + ps.count + "</span>";
      chip.innerHTML = '<span class="dot"></span>' + escapeHtml(s.name) + extra;
      chip.addEventListener("click", () => {
        if (!avail) {
          openSettings(s.keyName);
          return;
        }
        state.enabled[s.id] = !state.enabled[s.id];
        store.set("enabled", state.enabled);
        renderChips();
        if (state.query) startSearch(state.query);
      });
      wrap.appendChild(chip);
    });
  }

  // ---------------- 検索履歴 ----------------
  function renderHistory() {
    const hist = store.get("history", []);
    const wrap = $("history");
    wrap.innerHTML = "";
    if (!hist.length) return;
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "最近:";
    wrap.appendChild(label);
    hist.slice(0, 10).forEach((q) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = q;
      b.addEventListener("click", () => {
        $("q").value = q;
        startSearch(q);
      });
      wrap.appendChild(b);
    });
    const clr = document.createElement("button");
    clr.type = "button";
    clr.textContent = "履歴を消去";
    clr.addEventListener("click", () => {
      store.set("history", []);
      renderHistory();
    });
    wrap.appendChild(clr);
  }
  function pushHistory(q) {
    const hist = store.get("history", []).filter((h) => h !== q);
    hist.unshift(q);
    store.set("history", hist.slice(0, 20));
    renderHistory();
  }

  // ---------------- おすすめ ----------------
  ["富士山", "猫", "桜", "浮世絵", "nebula", "夜景", "ゴッホ", "恐竜", "mountain lake", "古地図"].forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q;
    b.addEventListener("click", () => {
      $("q").value = q;
      startSearch(q);
    });
    $("suggest").appendChild(b);
  });

  // ---------------- 検索 ----------------
  function filters() {
    return {
      orientation: $("orientation").value,
      commercial: $("commercial").checked,
    };
  }

  function startSearch(query) {
    query = (query || "").trim();
    if (!query) return;
    state.query = query;
    state.generation++;
    state.items = [];
    state.seen = new Set();
    state.perSource = {};
    activeSources().forEach((s) => (state.perSource[s.id] = { page: 0, hasMore: true, count: 0, error: null }));
    $("results").innerHTML = "";
    $("welcome").hidden = true;
    $("endMsg").hidden = true;
    $("statusBar").hidden = true;
    $("webSearch").hidden = false;
    renderEngineLinks(query);
    pushHistory(query);
    renderChips();

    const url = new URL(location.href);
    url.searchParams.set("q", query);
    history.replaceState(null, "", url);
    document.title = query + " - ワイド画像検索";

    if (!activeSources().length) {
      showStatus("検索ソースが選択されていません。上のボタンから1つ以上オンにしてください。");
      return;
    }
    loadMore();
  }

  async function loadMore() {
    if (state.loading || !state.query) return;
    const pending = activeSources().filter((s) => state.perSource[s.id] && state.perSource[s.id].hasMore);
    if (!pending.length) {
      finish();
      return;
    }
    state.loading = true;
    $("loader").hidden = false;
    const gen = state.generation;
    const f = filters();

    const results = await Promise.all(
      pending.map(async (s) => {
        const ps = state.perSource[s.id];
        const page = ps.page + 1;
        try {
          const r = await s.search({ query: state.query, page, keys: state.keys, ...f });
          return { s, page, r };
        } catch (e) {
          return { s, page, e };
        }
      })
    );
    if (gen !== state.generation) return; // 新しい検索に切り替わった

    const batches = [];
    results.forEach(({ s, page, r, e }) => {
      const ps = state.perSource[s.id];
      if (e) {
        ps.error = e.message || String(e);
        ps.hasMore = false;
        console.warn("[" + s.name + "]", e);
        return;
      }
      ps.page = page;
      ps.hasMore = r.hasMore && r.items.length > 0;
      const fresh = r.items.filter((it) => {
        if (!it.thumb || state.seen.has(it.thumb)) return false;
        state.seen.add(it.thumb);
        return true;
      });
      ps.count += fresh.length;
      batches.push(fresh);
    });

    // 各ソースを交互に並べて偏りを防ぐ
    const merged = [];
    for (let i = 0; batches.some((b) => i < b.length); i++) {
      batches.forEach((b) => b[i] && merged.push(b[i]));
    }
    appendCards(merged);

    state.loading = false;
    $("loader").hidden = true;
    renderChips();
    updateStatus();

    if (!activeSources().some((s) => state.perSource[s.id] && state.perSource[s.id].hasMore)) {
      finish();
    } else if (isSentinelVisible()) {
      // 画面が埋まっていなければ続けて読み込む
      loadMore();
    }
  }

  function finish() {
    $("loader").hidden = true;
    if (state.items.length) $("endMsg").hidden = false;
    updateStatus();
  }

  function updateStatus() {
    const n = state.items.length;
    const errs = activeSources().filter((s) => state.perSource[s.id] && state.perSource[s.id].error);
    let msg = n
      ? "「" + state.query + "」の画像 " + n + " 件を表示中"
      : state.loading
      ? ""
      : "「" + state.query + "」に一致する画像が見つかりませんでした。英語のキーワードや、下の検索エンジンもお試しください。";
    if (errs.length) msg += "（" + errs.map((s) => s.name).join("・") + " は取得に失敗しました）";
    showStatus(msg);
  }
  function showStatus(msg) {
    $("statusBar").textContent = msg;
    $("statusBar").hidden = !msg;
  }

  const sourceName = (id) => (SOURCES.find((s) => s.id === id) || {}).name || id;

  function appendCards(items) {
    const frag = document.createDocumentFragment();
    items.forEach((it) => {
      const idx = state.items.push(it) - 1;
      const card = document.createElement("button");
      card.type = "button";
      card.className = "card";
      card.dataset.idx = idx;
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.alt = it.title || "";
      if (it.width && it.height) {
        img.width = it.width;
        img.height = it.height;
        img.style.aspectRatio = it.width + " / " + it.height;
      }
      img.src = it.thumb;
      img.addEventListener("error", () => {
        // サムネイルが壊れていれば元画像で再試行、だめならカードを消す
        if (it.full && img.src !== it.full && !img.dataset.retried) {
          img.dataset.retried = "1";
          img.src = it.full;
        } else {
          card.remove();
        }
      });
      card.appendChild(img);
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = sourceName(it.source);
      card.appendChild(badge);
      const ov = document.createElement("span");
      ov.className = "overlay";
      ov.innerHTML =
        '<span class="t">' + escapeHtml(it.title || "(無題)") + "</span>" + (it.author ? escapeHtml(it.author) : "");
      card.appendChild(ov);
      card.addEventListener("click", () => openLightbox(idx));
      frag.appendChild(card);
    });
    $("results").appendChild(frag);
  }

  // ---------------- 無限スクロール ----------------
  function isSentinelVisible() {
    const r = $("sentinel").getBoundingClientRect();
    return r.top < window.innerHeight + 600;
  }
  new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    },
    { rootMargin: "600px" }
  ).observe($("sentinel"));

  // ---------------- フォーム ----------------
  $("searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    startSearch($("q").value);
  });
  ["orientation", "commercial"].forEach((id) =>
    $(id).addEventListener("change", () => {
      store.set("filter:" + id, $(id).type === "checkbox" ? $(id).checked : $(id).value);
      if (state.query) startSearch(state.query);
    })
  );
  $("layout").addEventListener("change", () => {
    $("results").className = "results " + $("layout").value;
    store.set("filter:layout", $("layout").value);
  });
  $("orientation").value = store.get("filter:orientation", "");
  $("commercial").checked = store.get("filter:commercial", false);
  $("layout").value = store.get("filter:layout", "masonry");
  $("results").className = "results " + $("layout").value;

  function renderEngineLinks(q) {
    const wrap = $("engineLinks");
    wrap.innerHTML = "";
    webEngines.forEach((e) => {
      const a = document.createElement("a");
      a.href = e.url(q);
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = e.name + " ↗";
      wrap.appendChild(a);
    });
  }

  // ---------------- ライトボックス ----------------
  function openLightbox(idx) {
    const it = state.items[idx];
    if (!it) return;
    state.lbIndex = idx;
    const img = $("lbImg");
    img.referrerPolicy = "no-referrer";
    img.src = it.thumb; // まずサムネイルを即表示し、元画像に差し替え
    img.alt = it.title || "";
    if (it.full && it.full !== it.thumb) {
      const hi = new Image();
      hi.referrerPolicy = "no-referrer";
      hi.onload = () => {
        if (state.lbIndex === idx) img.src = it.full;
      };
      hi.src = it.full;
    }
    $("lbTitle").textContent = it.title || "(無題)";
    const rows = [
      ["ソース", sourceName(it.source) + (it.via ? "（" + it.via + "）" : "")],
      ["作者", it.author],
      ["ライセンス", it.license],
      ["サイズ", it.width && it.height ? it.width + " × " + it.height + " px" : ""],
    ].filter((r) => r[1]);
    $("lbMeta").innerHTML = rows
      .map((r) => "<dt>" + escapeHtml(r[0]) + "</dt><dd>" + escapeHtml(String(r[1])) + "</dd>")
      .join("");
    $("lbOpen").href = it.full || it.thumb;
    $("lbPage").href = it.pageUrl || it.full;
    $("lbPage").hidden = !it.pageUrl;
    $("lightbox").hidden = false;
    document.body.style.overflow = "hidden";
    $("lbPrev").disabled = idx <= 0;
    $("lbNext").disabled = idx >= state.items.length - 1;
  }
  function closeLightbox() {
    $("lightbox").hidden = true;
    document.body.style.overflow = "";
    state.lbIndex = -1;
  }
  function stepLightbox(d) {
    const n = state.lbIndex + d;
    if (n >= 0 && n < state.items.length) openLightbox(n);
    if (n >= state.items.length - 5) loadMore();
  }
  $("lbClose").addEventListener("click", closeLightbox);
  $("lbPrev").addEventListener("click", () => stepLightbox(-1));
  $("lbNext").addEventListener("click", () => stepLightbox(1));
  $("lightbox").addEventListener("click", (e) => {
    if (e.target === $("lightbox") || e.target.classList.contains("lb-img-wrap")) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if ($("lightbox").hidden) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") stepLightbox(-1);
    else if (e.key === "ArrowRight") stepLightbox(1);
  });
  // スワイプ操作
  let touchX = null;
  $("lightbox").addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
  $("lightbox").addEventListener("touchend", (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 60) stepLightbox(dx < 0 ? 1 : -1);
    touchX = null;
  });

  $("lbDownload").addEventListener("click", async () => {
    const it = state.items[state.lbIndex];
    if (!it) return;
    const url = it.full || it.thumb;
    const name = (it.title || "image").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
    try {
      const res = await fetch(url, { mode: "cors", referrerPolicy: "no-referrer" });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg").replace("svg+xml", "svg");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name + "." + ext;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      // CORSで直接保存できない場合は新しいタブで開く
      window.open(url, "_blank", "noopener");
      toast("新しいタブで開きました。右クリック →「名前を付けて保存」で保存できます");
    }
  });
  $("lbCopy").addEventListener("click", async () => {
    const it = state.items[state.lbIndex];
    if (!it) return;
    try {
      await navigator.clipboard.writeText(it.full || it.thumb);
      toast("画像URLをコピーしました");
    } catch (e) {
      toast("コピーできませんでした");
    }
  });
  $("lbReverse").addEventListener("click", () => {
    const it = state.items[state.lbIndex];
    if (!it) return;
    closeLightbox();
    showTab("reverse");
    $("imgUrl").value = it.full || it.thumb;
    reverseByUrl(it.full || it.thumb);
  });

  // ---------------- 画像で検索 ----------------
  function reverseByUrl(url) {
    if (!/^https?:\/\//i.test(url)) {
      toast("http:// または https:// で始まる画像URLを入力してください");
      return;
    }
    $("reversePreview").hidden = false;
    $("reverseImg").referrerPolicy = "no-referrer";
    $("reverseImg").src = url;
    $("reverseNote").textContent = "検索したいサービスを選んでください（新しいタブで開きます）:";
    const wrap = $("reverseLinks");
    wrap.innerHTML = "";
    reverseEngines.forEach((e) => {
      const a = document.createElement("a");
      a.href = e.url(url);
      a.target = "_blank";
      a.rel = "noopener";
      a.innerHTML = escapeHtml(e.name) + " ↗<small>" + escapeHtml(e.note) + "</small>";
      wrap.appendChild(a);
    });
    const acts = $("reverseActions");
    acts.innerHTML = "";
    const all = document.createElement("button");
    all.className = "btn primary";
    all.type = "button";
    all.textContent = "すべてのサービスで一括検索";
    all.addEventListener("click", () => {
      let blocked = 0;
      reverseEngines.forEach((e) => {
        if (!window.open(e.url(url), "_blank", "noopener")) blocked++;
      });
      if (blocked) toast("ポップアップがブロックされました。ブラウザで許可してください");
    });
    acts.appendChild(all);
  }

  function reverseByFile(file) {
    if (!file || !/^image\//.test(file.type)) {
      toast("画像ファイルを選択してください");
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    $("reversePreview").hidden = false;
    $("reverseImg").src = objectUrl;
    $("reverseNote").innerHTML =
      "ローカルの画像はブラウザから直接送信できないため、下の「画像を保存」でファイルを用意し、各サービスの画面にドラッグ＆ドロップしてください。" +
      "（Webに公開されている画像なら、URLを入力するとワンクリックで検索できます）";
    const wrap = $("reverseLinks");
    wrap.innerHTML = "";
    reverseEngines.forEach((e) => {
      const a = document.createElement("a");
      a.href = e.upload;
      a.target = "_blank";
      a.rel = "noopener";
      a.innerHTML = escapeHtml(e.name) + " ↗<small>" + escapeHtml(e.note) + "</small>";
      wrap.appendChild(a);
    });
    const acts = $("reverseActions");
    acts.innerHTML = "";
    const save = document.createElement("a");
    save.className = "btn";
    save.href = objectUrl;
    save.download = file.name || "image.png";
    save.textContent = "画像を保存";
    acts.appendChild(save);
    if (navigator.clipboard && window.ClipboardItem) {
      const copy = document.createElement("button");
      copy.className = "btn primary";
      copy.type = "button";
      copy.textContent = "画像をクリップボードにコピー（各サービスで Ctrl+V 可）";
      copy.addEventListener("click", async () => {
        try {
          const png = await toPngBlob(file);
          await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
          toast("コピーしました。各サービスの画面で貼り付けてください");
        } catch (e) {
          toast("コピーできませんでした");
        }
      });
      acts.appendChild(copy);
    }
  }

  function toPngBlob(file) {
    if (file.type === "image/png") return Promise.resolve(file);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  $("reverseForm").addEventListener("submit", (e) => {
    e.preventDefault();
    reverseByUrl($("imgUrl").value.trim());
  });
  $("fileInput").addEventListener("change", (e) => reverseByFile(e.target.files[0]));
  const dz = $("dropZone");
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      $("fileInput").click();
    }
  });
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove("drag")));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (dt.files && dt.files[0]) return reverseByFile(dt.files[0]);
    const url = dt.getData("text/uri-list") || dt.getData("text/plain");
    if (url) {
      $("imgUrl").value = url.trim();
      reverseByUrl(url.trim());
    }
  });
  document.addEventListener("paste", (e) => {
    if ($("panel-reverse").hidden) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        e.preventDefault();
        reverseByFile(item.getAsFile());
        return;
      }
    }
  });

  // ---------------- 設定 ----------------
  function openSettings(focusKey) {
    const wrap = $("keyFields");
    wrap.innerHTML = "";
    SOURCES.filter((s) => s.keyName).forEach((s) => {
      const div = document.createElement("div");
      div.className = "key-field";
      div.innerHTML =
        '<label for="key-' + s.keyName + '">' + escapeHtml(s.name) + " APIキー</label>" +
        '<input id="key-' + s.keyName + '" type="password" autocomplete="off" spellcheck="false" />' +
        '<a href="' + s.homepage + '" target="_blank" rel="noopener">無料でAPIキーを取得 ↗</a>';
      div.querySelector("input").value = state.keys[s.keyName] || "";
      wrap.appendChild(div);
    });
    $("settings").showModal();
    if (focusKey) {
      const el = $("key-" + focusKey);
      if (el) el.focus();
    }
  }
  $("settingsBtn").addEventListener("click", () => openSettings());
  $("settings").addEventListener("close", () => {
    if ($("settings").returnValue !== "save") return;
    SOURCES.filter((s) => s.keyName).forEach((s) => {
      const v = $("key-" + s.keyName).value.trim();
      if (v) {
        if (!state.keys[s.keyName]) state.enabled[s.id] = true;
        state.keys[s.keyName] = v;
      } else delete state.keys[s.keyName];
    });
    store.set("keys", state.keys);
    store.set("enabled", state.enabled);
    renderChips();
    toast("保存しました");
    if (state.query) startSearch(state.query);
  });

  // ---------------- util ----------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------- 初期化 ----------------
  renderChips();
  renderHistory();
  const initial = new URL(location.href).searchParams.get("q");
  if (initial) {
    $("q").value = initial;
    startSearch(initial);
  } else {
    $("q").focus();
  }
})();
