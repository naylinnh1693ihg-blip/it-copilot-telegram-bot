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
  var view = script.getAttribute("data-view") || "";
  var webApp = telegram();
  if (surface === "miniapp" && webApp) {
    webApp.ready();
    webApp.expand();
    applyTheme();
  }
  if (view === "home") {
    if (webApp && webApp.BackButton) webApp.BackButton.hide();
    return;
  }
  if (view === "birthdays") {
    renderBirthdays();
    return;
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
    var field = theme.section_bg_color || theme.secondary_bg_color;
    if (!field && theme.text_color && !isLight(theme.text_color)) field = "#1c1c1e";
    if (field) root.style.setProperty("--field", field);
    if (theme.section_separator_color) root.style.setProperty("--line", theme.section_separator_color);
    root.style.colorScheme = isLight(theme.bg_color || theme.secondary_bg_color || "#ffffff") ? "light" : "dark";
  }

  function isLight(color) {
    var hex = String(color || "").replace("#", "");
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return true;
    var r = parseInt(hex.slice(0, 2), 16);
    var g = parseInt(hex.slice(2, 4), 16);
    var b = parseInt(hex.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150;
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

  function refreshVisibility() {
    if (!definition) return;
    definition.fields.forEach(function (field) {
      var wrap = document.getElementById("wrap-" + field.name);
      if (wrap) wrap.hidden = !fieldShown(field);
    });
  }

  function fieldShown(field) {
    if (!field.showWhen) return true;
    var other = document.getElementById("field-" + field.showWhen.field);
    return !!other && other.value === field.showWhen.equals;
  }

  function readFields() {
    var body = {};
    definition.fields.forEach(function (field) {
      if (!fieldShown(field)) {
        body[field.name] = field.type === "day_month" ? { day: "", month: "", year: "" } : "";
        return;
      }
      if (field.type === "day_month") {
        body[field.name] = {
          day: valueOf("field-" + field.name + "-day"),
          month: valueOf("field-" + field.name + "-month"),
          year: valueOf("field-" + field.name + "-year"),
        };
        return;
      }
      var input = document.getElementById("field-" + field.name);
      body[field.name] = input ? input.value : "";
    });
    return body;
  }

  function valueOf(id) {
    var node = document.getElementById(id);
    return node ? node.value : "";
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
    var params = [];
    if (query) params.push("q=" + encodeURIComponent(query));
    var subnet = document.getElementById("subnet");
    if (subnet && subnet.value) params.push("subnet=" + encodeURIComponent(subnet.value));
    if (params.length) path += "?" + params.join("&");
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
          if (record.depth) row.style.paddingLeft = (record.depth * 16) + "px";
          if (record.columns && record.columns.length) {
            record.columns.forEach(function (column) {
              var cell = document.createElement("span");
              cell.textContent = column || "—";
              row.appendChild(cell);
            });
          } else {
            var title = document.createElement("strong");
            title.textContent = "#" + record.number + " " + record.title;
            var detail = document.createElement("span");
            detail.textContent = record.detail || "";
            row.appendChild(title);
            if (record.detail) row.appendChild(detail);
          }
          if (record.legacy) {
            var legacy = document.createElement("span");
            legacy.textContent = record.legacy;
            row.appendChild(legacy);
          }
          list.appendChild(row);
        });
      })
      .catch(function () {
        list.textContent = "The list could not be loaded. Reload the page and try again.";
      });
  }

  function finishSave(body) {
    var another = formId === "location";
    var webApp = telegram();
    if (surface === "miniapp" && webApp && webApp.HapticFeedback) webApp.HapticFeedback.notificationOccurred("success");
    if (surface === "miniapp" && !another) {
      if (webApp) webApp.close();
      return;
    }
    var status = document.getElementById("status");
    if (status) {
      status.className = "ok";
      status.textContent = another
        ? "Saved #" + body.number + ": " + body.summary + ". Add another, or choose this one as the parent."
        : "Saved #" + body.number + ": " + body.summary + ".";
    }
    definition.fields.forEach(function (field) {
      if (field.type === "day_month") {
        ["day", "month", "year"].forEach(function (part) {
          var partInput = document.getElementById("field-" + field.name + "-" + part);
          if (partInput) partInput.value = "";
        });
      }
      var input = document.getElementById("field-" + field.name);
      if (!input) return;
      input.value = field.default || "";
      showError(field.name, "");
    });
    refreshRefs();
    var panel = document.getElementById("panel");
    if (panel) panel.hidden = !another;
    if (surface === "admin") loadRecords((document.getElementById("search") || {}).value || "");
    var name = document.getElementById("field-name");
    if (another && name) name.focus();
  }

  function refreshRefs() {
    if (!definition) return;
    definition.fields.forEach(function (field) {
      if (field.type !== "ref") return;
      var input = document.getElementById("field-" + field.name);
      if (input) fillRef(field, input);
    });
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
    if (field.type === "day_month") return dayMonthControl(field);
    if (field.type === "ref") return refControl(field);
    if (field.type === "textarea") input = document.createElement("textarea");
    else if (field.type === "select" || field.type === "country") {
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
      var plain = { tags: 1, ipv4: 1, isbn: 1, cidr: 1, mac: 1, vlan: 1 };
      input.type = plain[field.type] ? "text" : field.type;
      if (field.type === "ipv4" || field.type === "vlan") input.setAttribute("inputmode", "decimal");
    }
    input.id = "field-" + field.name;
    input.placeholder = field.placeholder || "";
    input.maxLength = field.maxLength;
    input.setAttribute("aria-describedby", "error-" + field.name);
    if (field.required) input.setAttribute("aria-required", "true");
    input.addEventListener("input", function () { showError(field.name, ""); });
    return input;
  }

  function dayMonthControl(field) {
    var box = document.createElement("div");
    box.className = "day-month";
    ["day", "month", "year"].forEach(function (part) {
      var input = document.createElement("input");
      input.id = "field-" + field.name + "-" + part;
      input.placeholder = part === "year" ? "Year, optional" : part === "day" ? "Day" : "Month";
      input.setAttribute("inputmode", "numeric");
      input.addEventListener("input", function () { showError(field.name, ""); });
      box.appendChild(input);
    });
    return box;
  }

  function refControl(field) {
    var box = document.createElement("div");
    var input = document.createElement("select");
    input.id = "field-" + field.name;
    var none = document.createElement("option");
    none.value = "";
    none.textContent = field.required ? "Choose…" : "None";
    input.appendChild(none);
    input.addEventListener("change", function () { showError(field.name, ""); });
    fillRef(field, input);
    box.appendChild(input);
    return box;
  }

  function fillRef(field, input) {
    var selected = input.value;
    fetch(apiBase + "/records/" + encodeURIComponent(field.refForm || ""), { headers: authHeaderNow() })
      .then(function (response) { return response.ok ? response.json() : { records: [] }; })
      .then(function (body) {
        var label = input.options[0] ? input.options[0].textContent : (field.required ? "Choose…" : "None");
        input.textContent = "";
        var none = document.createElement("option");
        none.value = "";
        none.textContent = label;
        input.appendChild(none);
        var records = (body && body.records) || [];
        records.forEach(function (record) {
          var option = document.createElement("option");
          option.value = record.id || "";
          option.textContent = record.title || ("#" + record.number);
          input.appendChild(option);
        });
        input.value = selected;
        var box = input.parentNode;
        if (records.length > 20 && box && !box.querySelector("input[type='search']")) {
          var filter = document.createElement("input");
          filter.type = "search";
          filter.placeholder = "Search";
          filter.addEventListener("input", function () {
            var needle = filter.value.toLowerCase();
            Array.prototype.forEach.call(input.options, function (option, index) {
              if (index === 0) return;
              option.hidden = needle && option.textContent.toLowerCase().indexOf(needle) === -1;
            });
          });
          box.insertBefore(filter, input);
        }
      })
      .catch(function () {});
  }

  function renderBirthdays() {
    app.textContent = "";
    var heading = document.createElement("h1");
    heading.textContent = "Birthdays";
    var list = document.createElement("section");
    list.className = "records";
    app.appendChild(heading);
    app.appendChild(list);
    fetch(apiBase + "/records/birthdays", { headers: authHeaderNow() })
      .then(function (response) { return response.ok ? response.json() : { records: [] }; })
      .then(function (body) {
        var records = (body && body.records) || [];
        if (!records.length) {
          list.textContent = "No birthdays are saved yet.";
          return;
        }
        records.forEach(function (record) {
          var row = document.createElement("div");
          row.className = "record";
          (record.columns || []).forEach(function (column) {
            if (!column) return;
            var cell = document.createElement("span");
            cell.textContent = column;
            row.appendChild(cell);
          });
          list.appendChild(row);
        });
      })
      .catch(function () {
        list.textContent = "The birthday list could not be loaded.";
      });
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
      if (form.subnetFilter) {
        var subnet = document.createElement("input");
        subnet.id = "subnet";
        subnet.className = "search";
        subnet.placeholder = "Filter by subnet, such as 192.168.1.0/24";
        subnet.addEventListener("input", function () { loadRecords(search.value); });
        toolbar.appendChild(subnet);
      }
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
      wrap.id = "wrap-" + field.name;
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
    grid.addEventListener("change", refreshVisibility);
    refreshVisibility();
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
