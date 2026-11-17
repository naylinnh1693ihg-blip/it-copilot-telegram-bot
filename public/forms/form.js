(function () {
  var script = document.currentScript || document.querySelector("script[data-form]");
  if (!script) return;
  var formId = script.getAttribute("data-form") || "";
  var apiBase = script.getAttribute("data-api") || "";
  var surface = script.getAttribute("data-surface") || "admin";
  var app = document.getElementById("app");
  if (!app) return;

  var SECRET = "This looks like a secret. Don't store credentials here.";
  var IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  var definition = null;
  var saving = false;
  var webApp = telegram();
  if (surface === "miniapp" && webApp) {
    webApp.ready();
    webApp.expand();
    applyTheme();
  }

  function telegram() {
    return window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  }

  function applyTheme() {
    var webApp = telegram();
    if (!webApp || !webApp.themeParams) return;
    var theme = webApp.themeParams;
    var root = document.documentElement;
    if (theme.bg_color) root.style.setProperty("--bg", theme.bg_color);
    if (theme.text_color) root.style.setProperty("--text", theme.text_color);
    if (theme.hint_color) root.style.setProperty("--muted", theme.hint_color);
    if (theme.button_color) root.style.setProperty("--accent", theme.button_color);
    if (theme.button_text_color) root.style.setProperty("--on-accent", theme.button_text_color);
    if (theme.secondary_bg_color) root.style.setProperty("--surface", theme.secondary_bg_color);
  }

  function secretRisk(value) {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
    if (/\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password|passwd|private[_-]?key)\b\s*[:=]\s*\S+/i.test(value)) return true;
    if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value)) return true;
    if (/\b(?:xai|sk)-[A-Za-z0-9]{10,}\b/.test(value)) return true;
    return false;
  }

  function fieldMessage(field, value) {
    var text = String(value || "").trim();
    if (!text) {
      if (!field.required) return "";
      return field.requiredMessage || "Enter " + field.label.toLowerCase() + ".";
    }
    if (text.length > field.maxLength) return field.label + " must be " + field.maxLength + " characters or fewer.";
    if (field.type !== "tags" && secretRisk(text)) return SECRET;
    if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return "Enter an email address like ada@example.com.";
    if (field.type === "url" && !/^https?:\/\//i.test(text)) {
      return "Enter a full address that starts with https://, such as https://docs.vendor.com/firewall.";
    }
    if (field.type === "ipv4" && !IPV4.test(text)) return "Enter an IPv4 address like 192.168.1.10, or leave it blank.";
    if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return "Enter a real date as YYYY-MM-DD, such as 2024-03-01.";
    if (field.type === "select") {
      var allowed = (field.options || []).some(function (option) { return option.value === text; });
      if (!allowed) return field.requiredMessage || "Choose a " + field.label.toLowerCase() + ".";
    }
    if (field.type === "tags") {
      var tags = text.split(",").map(function (tag) { return tag.trim(); }).filter(Boolean);
      if (tags.length > 10) return "Enter up to 10 tags, separated by commas.";
      if (tags.some(function (tag) { return tag.length > 40; })) return "Each tag must be 40 characters or fewer.";
      if (secretRisk(tags.join(" "))) return SECRET;
    }
    return "";
  }

  function showError(name, message) {
    var node = document.getElementById("error-" + name);
    if (node) node.textContent = message;
    var input = document.getElementById("field-" + name);
    if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
  }

  function readFields() {
    var body = {};
    definition.fields.forEach(function (field) {
      var input = document.getElementById("field-" + field.name);
      body[field.name] = input ? input.value : "";
    });
    return body;
  }

  function validateAll() {
    var first = "";
    definition.fields.forEach(function (field) {
      var input = document.getElementById("field-" + field.name);
      var message = fieldMessage(field, input ? input.value : "");
      showError(field.name, message);
      if (message && !first) first = field.name;
    });
    if (first) {
      var target = document.getElementById("field-" + first);
      if (target) target.focus();
    }
    return !first;
  }

  function setProgress(on) {
    saving = on;
    var button = document.getElementById("save");
    if (button) button.disabled = on;
    var webApp = telegram();
    if (surface === "miniapp" && webApp && webApp.MainButton) {
      if (on) webApp.MainButton.showProgress(false);
      else webApp.MainButton.hideProgress();
    }
  }

  function authHeaders() {
    if (surface === "miniapp") {
      var webApp = telegram();
      return Promise.resolve({ "X-Telegram-Init-Data": webApp && webApp.initData ? webApp.initData : "" });
    }
    return fetch(apiBase + "/auth/session", { headers: { Accept: "application/json" } }).then(function (response) {
      if (response.status === 401) {
        window.location.href = "/admin/login";
        throw new Error("Sign in again.");
      }
      if (!response.ok) throw new Error("Could not check your session.");
      return response.json();
    }).then(function (body) {
      return { "X-CSRF-Token": body.csrfToken || "" };
    });
  }

  function loadRecords(query) {
    var list = document.getElementById("records");
    if (!list || surface !== "admin") return;
    var path = apiBase + "/records/" + encodeURIComponent(formId);
    if (query) path += "?q=" + encodeURIComponent(query);
    fetch(path, { headers: { Accept: "application/json" } })
      .then(function (response) {
        if (response.status === 401) {
          window.location.href = "/admin/login";
          return null;
        }
        if (!response.ok) throw new Error("Could not load the list.");
        return response.json();
      })
      .then(function (body) {
        if (!body) return;
        var records = body.records || [];
        list.textContent = "";
        if (!records.length) {
          var empty = document.createElement("p");
          empty.className = "empty";
          empty.textContent = query ? "Nothing matches that search." : "Nothing saved yet.";
          list.appendChild(empty);
          return;
        }
        records.forEach(function (record) {
          var row = document.createElement("div");
          row.className = "record";
          var title = document.createElement("strong");
          title.textContent = "#" + record.number + " " + record.title;
          var detail = document.createElement("span");
          detail.textContent = record.detail || "";
          row.appendChild(title);
          if (record.detail) row.appendChild(detail);
          list.appendChild(row);
        });
      })
      .catch(function () {
        list.textContent = "The list could not be loaded. Reload the page and try again.";
      });
  }

  function finishSave(body) {
    if (surface === "miniapp") {
      var webApp = telegram();
      if (webApp && webApp.HapticFeedback) webApp.HapticFeedback.notificationOccurred("success");
      if (webApp) webApp.close();
      return;
    }
    var status = document.getElementById("status");
    if (status) {
      status.className = "ok";
      status.textContent = "Saved #" + body.number + ": " + body.summary + ".";
    }
    definition.fields.forEach(function (field) {
      var input = document.getElementById("field-" + field.name);
      if (!input) return;
      input.value = field.default || "";
      showError(field.name, "");
    });
    var panel = document.getElementById("panel");
    if (panel) panel.hidden = true;
    loadRecords((document.getElementById("search") || {}).value || "");
  }

  function showServerErrors(errors) {
    var first = "";
    Object.keys(errors).forEach(function (name) {
      showError(name, errors[name]);
      if (!first) first = name;
    });
    if (first === "form") {
      var status = document.getElementById("status");
      if (status) {
        status.className = "banner";
        status.textContent = errors.form;
      }
    }
  }

  function save() {
    if (saving || !definition) return;
    if (!validateAll()) return;
    setProgress(true);
    authHeaders()
      .then(function (headers) {
        headers["Content-Type"] = "application/json";
        headers.Accept = "application/json";
        return fetch(apiBase + "/forms/" + encodeURIComponent(formId), {
          method: "POST",
          headers: headers,
          body: JSON.stringify(readFields()),
        });
      })
      .then(function (response) {
        return response.json().then(function (body) {
          return { status: response.status, body: body };
        });
      })
      .then(function (result) {
        setProgress(false);
        if (result.status === 201) {
          finishSave(result.body || {});
          return;
        }
        if (result.status === 422 && result.body && result.body.errors) {
          showServerErrors(result.body.errors);
          return;
        }
        var status = document.getElementById("status");
        if (status) {
          status.className = "banner";
          status.textContent = (result.body && result.body.error) || "Could not save. Check the fields and try again.";
        }
      })
      .catch(function (error) {
        setProgress(false);
        if (String(error && error.message) === "Sign in again.") return;
        var status = document.getElementById("status");
        if (status) {
          status.className = "banner";
          status.textContent = "Could not save. Check your connection and try again.";
        }
      });
  }

  function inputFor(field) {
    var input;
    if (field.type === "textarea") input = document.createElement("textarea");
    else if (field.type === "select") {
      input = document.createElement("select");
      var placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose…";
      input.appendChild(placeholder);
      (field.options || []).forEach(function (option) {
        var node = document.createElement("option");
        node.value = option.value;
        node.textContent = option.label;
        input.appendChild(node);
      });
      if (field.default) input.value = field.default;
    } else {
      input = document.createElement("input");
      input.type = field.type === "textarea" ? "text" : field.type === "tags" || field.type === "ipv4" ? "text" : field.type;
      if (field.type === "ipv4") input.setAttribute("inputmode", "decimal");
    }
    input.id = "field-" + field.name;
    input.placeholder = field.placeholder || "";
    input.maxLength = field.maxLength;
    input.setAttribute("aria-describedby", "error-" + field.name);
    if (field.required) input.setAttribute("aria-required", "true");
    input.addEventListener("input", function () { showError(field.name, ""); });
    return input;
  }

  function render(form) {
    definition = form;
    document.title = form.title;
    app.textContent = "";

    if (surface === "admin") {
      var toolbar = document.createElement("div");
      toolbar.className = "toolbar";
      var search = document.createElement("input");
      search.id = "search";
      search.className = "search";
      search.type = "search";
      search.placeholder = "Search saved records";
      search.addEventListener("input", function () { loadRecords(search.value); });
      var add = document.createElement("button");
      add.type = "button";
      add.textContent = "Add";
      add.addEventListener("click", function () {
        var panel = document.getElementById("panel");
        if (panel) panel.hidden = false;
        var first = definition.fields[0];
        var node = first ? document.getElementById("field-" + first.name) : null;
        if (node) node.focus();
      });
      toolbar.appendChild(search);
      toolbar.appendChild(add);
      var records = document.createElement("section");
      records.className = "records";
      records.id = "records";
      app.appendChild(toolbar);
      app.appendChild(records);
    }

    var panel = document.createElement("section");
    panel.className = "panel";
    panel.id = "panel";
    if (surface === "admin") panel.hidden = true;
    var head = document.createElement("div");
    head.className = "form-head";
    var heading = document.createElement("h1");
    heading.textContent = form.title;
    head.appendChild(heading);
    if (surface === "admin") {
      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", function () { panel.hidden = true; });
      head.appendChild(cancel);
    }
    panel.appendChild(head);
    var status = document.createElement("p");
    status.id = "status";
    panel.appendChild(status);
    var grid = document.createElement("div");
    grid.className = "grid";
    form.fields.forEach(function (field) {
      var wrap = document.createElement("div");
      wrap.className = "field" + (field.wide ? " wide" : "");
      var label = document.createElement("label");
      label.htmlFor = "field-" + field.name;
      label.appendChild(document.createTextNode(field.label));
      if (field.required) {
        var star = document.createElement("span");
        star.className = "req";
        star.setAttribute("aria-hidden", "true");
        star.textContent = " *";
        label.appendChild(star);
      }
      var error = document.createElement("p");
      error.className = "field-error";
      error.id = "error-" + field.name;
      wrap.appendChild(label);
      wrap.appendChild(inputFor(field));
      wrap.appendChild(error);
      grid.appendChild(wrap);
    });
    panel.appendChild(grid);
    var saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.id = "save";
    saveButton.textContent = form.submitLabel;
    saveButton.addEventListener("click", save);
    var webApp = telegram();
    if (surface === "miniapp" && webApp && webApp.MainButton) saveButton.hidden = true;
    panel.appendChild(saveButton);
    app.appendChild(panel);
    if (surface === "admin") loadRecords("");
  }

  function bootTelegram(form) {
    if (surface !== "miniapp" || !webApp) return;
    if (webApp.MainButton) {
      webApp.MainButton.setText(form.submitLabel);
      webApp.MainButton.show();
      webApp.MainButton.onClick(save);
    }
    if (webApp.BackButton) {
      webApp.BackButton.show();
      webApp.BackButton.onClick(function () { webApp.close(); });
    }
  }

  fetch(apiBase + "/forms/" + encodeURIComponent(formId), { headers: authHeaderNow() })
    .then(function (response) {
      if (response.status === 401 && surface === "admin") {
        window.location.href = "/admin/login";
        return null;
      }
      if (!response.ok) throw new Error("Could not load the form.");
      return response.json();
    })
    .then(function (form) {
      if (!form) return;
      render(form);
      bootTelegram(form);
    })
    .catch(function () {
      app.textContent = "This form could not be loaded. Reload the page and try again.";
    });

  function authHeaderNow() {
    if (surface !== "miniapp") return { Accept: "application/json" };
    var webApp = telegram();
    return {
      Accept: "application/json",
      "X-Telegram-Init-Data": webApp && webApp.initData ? webApp.initData : "",
    };
  }
})();
