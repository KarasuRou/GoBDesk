import "./style.css";
import { computeInvoiceTotals, type LineInput } from "../../core/tax";
import { VERFDOK_FIELDS } from "../../shared/api";
import type {
  CompanySettings,
  CompanySettingsInput,
  CustomerDetail,
  CustomerInput,
  DocumentDetail,
  DocumentFilter,
  DocumentListItem,
  DocumentType,
  DraftInvoiceInput,
  LinkTargets,
  EuerCategory,
  ExpenseDetail,
  GobdReport,
  InvoiceDetail,
  InvoiceFilter,
  JournalEntry,
  InvoiceItemDetail,
  InvoiceLineInput,
  InvoiceListItem,
  LineAdjustment,
  OrderDetail,
  OrderInput,
  OrderListItem,
  OrderOption,
  OrderStatus,
  TaxRate,
} from "../../shared/api";

const api = window.gobdesk;

type ViewName =
  | "dashboard"
  | "customers"
  | "invoices"
  | "orders"
  | "euer"
  | "documents"
  | "journal"
  | "settings";

function el<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Element ${selector} nicht gefunden`);
  return node;
}

const eur = (cents: number): string =>
  (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
  " €";

const fmtDate = (dateStr: string | null | undefined): string => {
  if (!dateStr) return "—";
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
  }
  return dateStr;
};

const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("de-DE");
};

/** Menschenlesbarer Fehlertext: entfernt das technische Electron-IPC-Präfix
 *  („Error invoking remote method 'x:y': Error: …"). */
const msg = (e: unknown): string => {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, "");
};

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: string | null | undefined): string =>
  (value ?? "").replace(/[&<>"']/g, (ch) => ESCAPE[ch] ?? ch);

const today = (): string => new Date().toISOString().slice(0, 10);
const toMilli = (v: string): number => Math.round((parseFloat(v.replace(",", ".")) || 0) * 1000);
const toCents = (v: string): number => Math.round((parseFloat(v.replace(",", ".")) || 0) * 100);

// --- Router ---------------------------------------------------------------

function showView(name: ViewName): void {
  document
    .querySelectorAll<HTMLElement>(".view")
    .forEach((v) => v.classList.toggle("hidden", v.dataset.view !== name));
  document
    .querySelectorAll<HTMLElement>(".nav-item")
    .forEach((n) => n.classList.toggle("active", n.dataset.view === name));

  if (name === "dashboard") void renderDashboard();
  else if (name === "customers") {
    el("#customer-detail").classList.add("hidden");
    el("#customer-form").classList.add("hidden");
    el("#customer-list-card").classList.remove("hidden");
    void renderCustomers();
  }
  else if (name === "invoices") {
    resetInvoiceView();
    void renderInvoices();
  }
  else if (name === "orders") {
    el("#order-detail").classList.add("hidden");
    el("#order-form").classList.add("hidden");
    el("#order-list-card").classList.remove("hidden");
    void renderOrders();
  }
  else if (name === "euer") void renderEuer();
  else if (name === "documents") {
    el("#document-detail").classList.add("hidden");
    el("#documents-list-card").classList.remove("hidden");
    void ensureDocFilters();
    void renderDocuments();
  }
  else if (name === "journal") void renderJournal();
  else if (name === "settings") void renderSettings();
}

// --- Dashboard ------------------------------------------------------------

/** Warnbanner: automatischer Integritäts-Check + IKS-Backup-Erinnerung. */
async function renderDashboardWarnings(): Promise<void> {
  const [quick, storage] = await Promise.all([api.gobdQuickCheck(), api.getStorageInfo()]);
  const banners: string[] = [];

  if (!quick.ok) {
    const details: string[] = [];
    if (!quick.chainOk) details.push(`Journal-Hash-Kette gebrochen bei Eintrag #${quick.brokenAtId}`);
    if (quick.tampered > 0) details.push(`${quick.tampered} Rechnung(en) mit abweichender Prüfsumme`);
    banners.push(
      `<div class="banner banner-error">⚠ <strong>Integritätsproblem erkannt:</strong> ${details.join(" · ")}.
        Details in der GoBD-Prüfung unten.</div>`,
    );
  }
  if (quick.nonMonotonic > 0) {
    banners.push(
      `<div class="banner banner-warn">🕐 ${quick.nonMonotonic} Journaleintrag/-einträge mit
        rückläufigem Zeitstempel – wurde zwischenzeitlich die Systemuhr zurückgestellt?</div>`,
    );
  }

  const backupDays =
    storage.lastBackupAt != null
      ? Math.floor((Date.now() - new Date(storage.lastBackupAt).getTime()) / 86_400_000)
      : null;
  if (backupDays === null || backupDays > 7) {
    banners.push(
      `<div class="banner banner-warn">💾 ${
        backupDays === null
          ? "Noch keine Sicherung erstellt."
          : `Letzte Sicherung vor ${backupDays} Tagen.`
      } <button class="link" data-goto-settings>Jetzt sichern…</button></div>`,
    );
  }

  el("#dash-warnings").innerHTML = banners.join("");
}

async function renderDashboard(): Promise<void> {
  const year = new Date().getFullYear();
  void renderDashboardWarnings();
  const [settings, customers, invoices, report] = await Promise.all([
    api.getSettings(),
    api.listCustomers(),
    api.listInvoices(),
    api.euerReport(year),
  ]);

  // Subtitle/Header settings
  el("#dash-company-subtitle").textContent = settings
    ? `${settings.legal_name} · ${settings.is_kleinunternehmer ? "Kleinunternehmen" : "Regelbesteuerung"}`
    : "—";

  // Umsatz und Gewinn (KPIs)
  el("#dash-income-label").textContent = `Umsatz (${year})`;
  el("#dash-income").textContent = eur(report.income_net_cents);
  el("#dash-profit-label").textContent = `Gewinn (${year})`;
  
  const profitVal = el("#dash-profit");
  profitVal.textContent = eur(report.profit_cents);
  profitVal.className = "stat-value " + (report.profit_cents >= 0 ? "ok" : "error");

  // Offene Forderungen (KPI)
  const unpaidInvoices = invoices.filter((i) => i.status === "issued" && !i.is_paid);
  const unpaidCents = unpaidInvoices.reduce((acc, i) => acc + ((i.gross_total_cents ?? 0) - i.paid_cents), 0);
  el("#dash-outstanding").textContent = eur(unpaidCents);

  // Kunden (KPI)
  el("#dash-customers").textContent = String(customers.length);

  // Finanz-Schnellübersicht (EÜR progress & values)
  el("#dash-euer-title").textContent = `Finanz-Schnellübersicht (${year})`;
  const expensePercent = report.income_net_cents > 0
    ? Math.min(100, Math.round((report.expenses_total_cents / report.income_net_cents) * 100))
    : 0;

  el("#dash-euer-summary").innerHTML = `
    <div class="euer-line" style="border-bottom: 1px solid var(--border); padding: 8px 0; display: flex; justify-content: space-between;">
      <span>Betriebseinnahmen (netto)</span>
      <strong>${eur(report.income_net_cents)}</strong>
    </div>
    <div class="euer-line" style="border-bottom: 1px solid var(--border); padding: 8px 0; display: flex; justify-content: space-between;">
      <span>Betriebsausgaben</span>
      <strong>−${eur(report.expenses_total_cents)}</strong>
    </div>
    ${report.income_net_cents > 0 ? `
    <div class="euer-progress-container" title="Gewinnspanne: ${100 - expensePercent}%" style="margin: 16px 0; background: var(--border); height: 8px; border-radius: 4px; overflow: hidden;">
      <div class="euer-progress-bar" style="width: ${100 - expensePercent}%; background: var(--accent-gradient); height: 100%; border-radius: 4px;"></div>
    </div>
    ` : ""}
    <div class="euer-line total" style="padding: 10px 0; font-size: 15px; font-weight: 700; display: flex; justify-content: space-between;">
      <span>Gewinn / Verlust</span>
      <span class="${report.profit_cents >= 0 ? "ok" : "error"}">${eur(report.profit_cents)}</span>
    </div>
  `;

  // Letzte Rechnungen
  const sortedInvoices = [...invoices].sort((a, b) => {
    const da = a.issue_date || "";
    const db = b.issue_date || "";
    return db.localeCompare(da);
  });
  const recent = sortedInvoices.slice(0, 4);

  el("#dash-recent-invoices").innerHTML = recent.length === 0
    ? `<tr><td colspan="5" class="muted" style="text-align: center; padding: 12px;">Keine Rechnungen vorhanden.</td></tr>`
    : recent.map((i) => {
        const remaining = (i.gross_total_cents ?? 0) - i.paid_cents;
        const statusText = i.status === "draft"
          ? `<span class="badge badge-draft">Entwurf</span>`
          : i.status === "cancelled"
            ? `<span class="badge badge-cancelled">Storniert</span>`
            : i.cancels_invoice_id != null
              ? `<span class="badge badge-cancelled">Storno</span>`
              : i.is_paid
                ? `<span class="badge badge-paid">Bezahlt</span>`
                : remaining < (i.gross_total_cents ?? 0)
                  ? `<span class="badge badge-partial">Teilgezahlt</span>`
                  : `<span class="badge badge-open">Offen</span>`;
        return `
          <tr>
            <td><strong>${escapeHtml(i.invoice_number || "Entwurf")}</strong></td>
            <td>${escapeHtml(i.customer_name || "—")}</td>
            <td class="nowrap">${fmtDate(i.issue_date)}</td>
            <td class="num">${eur(i.gross_total_cents ?? 0)}</td>
            <td>${statusText}</td>
          </tr>
        `;
      }).join("");
}

// --- Kunden ---------------------------------------------------------------

let customerSearchTimer: number | undefined;

async function renderCustomers(): Promise<void> {
  const search = el<HTMLInputElement>("#customer-search").value;
  const customers = await api.listCustomersDetailed(search);
  el("#customers").innerHTML =
    customers.length === 0
      ? `<tr>
          <td colspan="6" class="table-empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <div class="title">${search ? "Keine Kunden gefunden" : "Keine Kunden vorhanden"}</div>
            <div class="desc">${search ? "Passe deinen Suchbegriff an oder setze ihn zurück." : "Lege einen neuen Kunden über die Schaltfläche oben rechts an."}</div>
          </td>
         </tr>`
      : customers
          .map(
            (c) => `<tr>
              <td><strong>${escapeHtml(c.name) || "—"}</strong>${
                c.customer_number ? ` <span class="muted">${escapeHtml(c.customer_number)}</span>` : ""
              }</td>
              <td>${escapeHtml(c.city) || "—"}</td>
              <td>${escapeHtml(c.email) || "—"}</td>
              <td class="num">${c.invoice_count}</td>
              <td class="num">${
                c.open_cents > 0 ? `<strong>${eur(c.open_cents)}</strong>` : `<span class="muted">—</span>`
              }</td>
              <td class="num row-actions">
                <button class="link" data-open-customer="${c.id}">Öffnen</button>
                <button class="link" data-edit="${c.id}">Bearbeiten</button>
              </td>
            </tr>`,
          )
          .join("");
}

let editingId: number | null = null;

function readCustomerForm(): CustomerInput {
  const form = el<HTMLFormElement>("#customer-form");
  const value = (name: string): string =>
    (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
  const kind = value("kind") === "individual" ? "individual" : "company";
  const name = value("name");
  return {
    kind,
    company_name: kind === "company" ? name : null,
    contact_last_name: kind === "individual" ? name : null,
    street: value("street"),
    zip: value("zip"),
    city: value("city"),
    country_iso: "DE",
    email: value("email"),
    vat_id: value("vat_id"),
  };
}

function fillCustomerForm(c: CustomerDetail | null): void {
  const form = el<HTMLFormElement>("#customer-form");
  const set = (name: string, val: string): void => {
    const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
    if (field) field.value = val;
  };
  set("kind", c?.kind ?? "company");
  set("name", c?.company_name ?? c?.contact_last_name ?? "");
  set("street", c?.street ?? "");
  set("zip", c?.zip ?? "");
  set("city", c?.city ?? "");
  set("email", c?.email ?? "");
  set("vat_id", c?.vat_id ?? "");
}

function openCustomerForm(detail: CustomerDetail | null): void {
  editingId = detail?.id ?? null;
  fillCustomerForm(detail);
  el("#form-error").textContent = "";
  el("#customer-form-title").textContent = editingId ? "Kunde bearbeiten" : "Neuer Kunde";
  el("#customer-form").classList.remove("hidden");
}

async function submitCustomer(ev: Event): Promise<void> {
  ev.preventDefault();
  try {
    const input = readCustomerForm();
    if (editingId) await api.updateCustomer(editingId, input);
    else await api.createCustomer(input);
    el("#customer-form").classList.add("hidden");
    editingId = null;
    await renderCustomers();
  } catch (err) {
    el("#form-error").textContent = msg(err);
  }
}

// --- Kunden-Detail --------------------------------------------------------

async function openCustomerDetail(id: number): Promise<void> {
  const [c, invoices] = await Promise.all([
    api.getCustomer(id),
    api.listInvoices({ customerId: id }),
  ]);
  if (!c) return;
  el("#customer-detail-title").textContent = c.company_name ?? c.contact_last_name ?? "Kunde";
  el("#customer-detail-info").innerHTML = `${escapeHtml(c.company_name ?? c.contact_last_name)}<br />
    ${escapeHtml(c.street)}, ${escapeHtml(c.zip)} ${escapeHtml(c.city)}<br />
    ${c.email ? escapeHtml(c.email) + "<br />" : ""}${c.vat_id ? "USt-IdNr: " + escapeHtml(c.vat_id) : ""}`;
  el("#customer-invoices").innerHTML =
    invoices.length === 0
      ? `<tr><td colspan="5" class="muted">Keine Rechnungen.</td></tr>`
      : invoices
          .map(
            (i) => `<tr>
              <td>${escapeHtml(i.invoice_number) || "—"}</td>
              <td class="nowrap">${fmtDate(i.issue_date)}</td>
              <td class="nowrap">${statusBadge(i)}${paymentBadge(i)}</td>
              <td class="num">${i.gross_total_cents != null ? eur(i.gross_total_cents) : "—"}</td>
              <td class="nowrap">${
                i.status === "issued"
                  ? `<button class="link" data-cust-open-invoice="${i.id}">Öffnen</button>`
                  : ""
              }${i.has_pdf ? ` <button class="link" data-pdf="${i.id}">PDF</button>` : ""}</td>
            </tr>`,
          )
          .join("");
  await renderLinkedDocuments("customer", id, "#customer-documents");
  el("#customer-list-card").classList.add("hidden");
  el("#customer-detail").classList.remove("hidden");
}

function backToCustomers(): void {
  el("#customer-detail").classList.add("hidden");
  el("#customer-list-card").classList.remove("hidden");
  void renderCustomers();
}

async function navigateToInvoice(id: number): Promise<void> {
  showView("invoices");
  await openInvoiceDetail(id);
}

// --- Einstellungen --------------------------------------------------------

async function renderSettings(): Promise<void> {
  const s = await api.getSettings();
  const hasCompany = Boolean(s && s.legal_name.trim());
  el("#settings-detail").innerHTML =
    hasCompany && s
      ? `<div class="settings-grid">
          <div class="settings-item">
            <span class="settings-label">Firmenname</span>
            <span class="settings-value">${escapeHtml(s.legal_name)}</span>
          </div>
          <div class="settings-item">
            <span class="settings-label">Adresse</span>
            <span class="settings-value">${escapeHtml(s.address_line1) || "—"}${
              s.address_line1 ? "<br />" : ""
            }${escapeHtml(s.zip)} ${escapeHtml(s.city)}</span>
          </div>
          <div class="settings-item">
            <span class="settings-label">Steuernummer</span>
            <span class="settings-value">${escapeHtml(s.tax_number) || "—"}</span>
          </div>
          <div class="settings-item">
            <span class="settings-label">USt-IdNr</span>
            <span class="settings-value">${escapeHtml(s.vat_id) || "—"}</span>
          </div>
          <div class="settings-item">
            <span class="settings-label">Besteuerungsart</span>
            <span class="settings-value">
              <span class="badge ${s.is_kleinunternehmer ? "badge-draft" : "badge-paid"}">
                ${s.is_kleinunternehmer ? "Kleinunternehmen (§19 UStG)" : "Regelbesteuerung"}
              </span>
            </span>
          </div>
          <div class="settings-item">
            <span class="settings-label">E-Mail</span>
            <span class="settings-value">${escapeHtml(s.email) || "—"}</span>
          </div>
          <div class="settings-item">
            <span class="settings-label">Bankverbindung (IBAN)</span>
            <span class="settings-value">${escapeHtml(s.iban) || "—"}</span>
          </div>
          <div class="settings-item">
            <span class="settings-label">Bankverbindung (BIC)</span>
            <span class="settings-value">${escapeHtml(s.bic) || "—"}</span>
          </div>
         </div>`
      : `<span class="muted">Noch keine Firmendaten hinterlegt. Klicke auf „Bearbeiten", um sie einzutragen – sie erscheinen auf jeder Rechnung.</span>`;
  await renderStorageInfo();
  await renderAboutCard();
}

function readCompanyForm(): CompanySettingsInput {
  const form = el<HTMLFormElement>("#company-form");
  const v = (name: string): string =>
    (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
  return {
    legal_name: v("legal_name"),
    address_line1: v("address_line1"),
    zip: v("zip"),
    city: v("city"),
    country_iso: v("country_iso") || "DE",
    tax_number: v("tax_number") || null,
    vat_id: v("vat_id") || null,
    is_kleinunternehmer: v("is_kleinunternehmer") === "1" ? 1 : 0,
    email: v("email") || null,
    iban: v("iban") || null,
    bic: v("bic") || null,
  };
}

function fillCompanyForm(s: CompanySettings | null): void {
  const form = el<HTMLFormElement>("#company-form");
  const set = (name: string, val: string): void => {
    const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
    if (field) field.value = val;
  };
  set("legal_name", s?.legal_name ?? "");
  set("address_line1", s?.address_line1 ?? "");
  set("zip", s?.zip ?? "");
  set("city", s?.city ?? "");
  set("country_iso", s?.country_iso ?? "DE");
  set("tax_number", s?.tax_number ?? "");
  set("vat_id", s?.vat_id ?? "");
  set("is_kleinunternehmer", s?.is_kleinunternehmer ? "1" : "0");
  set("email", s?.email ?? "");
  set("iban", s?.iban ?? "");
  set("bic", s?.bic ?? "");
}

async function openCompanyForm(): Promise<void> {
  fillCompanyForm(await api.getSettings());
  el("#company-error").textContent = "";
  el("#company-form").classList.remove("hidden");
}

async function submitCompany(ev: Event): Promise<void> {
  ev.preventDefault();
  try {
    await api.updateSettings(readCompanyForm());
    el("#company-form").classList.add("hidden");
    await renderSettings();
    void renderDashboard();
  } catch (err) {
    el("#company-error").textContent = msg(err);
  }
}

/** In-App-Bestätigung (ersetzt native confirm/alert-Dialoge). */
function confirmModal(opts: {
  title: string;
  message: string;
  okLabel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el("#modal-overlay");
    el("#modal-title").textContent = opts.title;
    el("#modal-message").textContent = opts.message;
    const okBtn = el<HTMLButtonElement>("#modal-ok");
    const cancelBtn = el<HTMLButtonElement>("#modal-cancel");
    okBtn.textContent = opts.okLabel ?? "OK";
    overlay.classList.remove("hidden");
    okBtn.focus();

    const close = (result: boolean): void => {
      overlay.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("mousedown", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = (): void => close(true);
    const onCancel = (): void => close(false);
    const onBackdrop = (e: MouseEvent): void => {
      if (e.target === overlay) close(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter") close(true);
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

/** Modal mit Texteingabe (z. B. Storno-Grund). null = abgebrochen. */
function promptModal(opts: {
  title: string;
  message: string;
  inputCaption: string;
  okLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = el("#modal-overlay");
    const inputLabel = el("#modal-input-label");
    const input = el<HTMLInputElement>("#modal-input");
    el("#modal-title").textContent = opts.title;
    el("#modal-message").textContent = opts.message;
    el("#modal-input-caption").textContent = opts.inputCaption;
    const okBtn = el<HTMLButtonElement>("#modal-ok");
    const cancelBtn = el<HTMLButtonElement>("#modal-cancel");
    okBtn.textContent = opts.okLabel ?? "OK";
    input.value = "";
    inputLabel.classList.remove("hidden");
    overlay.classList.remove("hidden");
    input.focus();

    const close = (result: string | null): void => {
      overlay.classList.add("hidden");
      inputLabel.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("mousedown", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = (): void => close(input.value.trim());
    const onCancel = (): void => close(null);
    const onBackdrop = (e: MouseEvent): void => {
      if (e.target === overlay) close(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close(null);
      else if (e.key === "Enter") close(input.value.trim());
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

async function renderStorageInfo(): Promise<void> {
  const info = await api.getStorageInfo();
  el("#storage-info").innerHTML = `
    <div class="settings-grid">
      <div class="settings-item">
        <span class="settings-label">Datenverzeichnis</span>
        <span class="settings-value" style="word-break: break-all;">
          ${escapeHtml(info.dataDir)}
          ${info.isCustom ? ` <span class="badge" style="margin-left: 6px;">eigener Ordner</span>` : ` <span class="badge badge-cancelled" style="margin-left: 6px;">Standard</span>`}
        </span>
      </div>
      <div class="settings-item">
        <span class="settings-label">Datenbankpfad</span>
        <span class="settings-value" style="word-break: break-all; font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted);">
          ${escapeHtml(info.dbPath)}
        </span>
      </div>
    </div>`;
}

// --- Über / Herkunft & Update-Prüfung -------------------------------------

let aboutRepoUrl = "https://github.com/KarasuRou/GoBDesk";
/** Automatische Update-Prüfung nur einmal pro Sitzung (Offline-First: kein Dauer-Ping). */
let updateChecked = false;

async function renderAboutCard(): Promise<void> {
  const info = await api.getAppInfo();
  aboutRepoUrl = info.repository;
  el("#about-info").innerHTML = `
    <div class="settings-grid">
      <div class="settings-item">
        <span class="settings-label">Version</span>
        <span class="settings-value">${escapeHtml(info.name)} ${escapeHtml(info.version)}</span>
      </div>
      <div class="settings-item">
        <span class="settings-label">Urheber</span>
        <span class="settings-value">© ${info.copyrightYear} ${escapeHtml(info.author)}</span>
      </div>
      <div class="settings-item">
        <span class="settings-label">Lizenz</span>
        <span class="settings-value">${escapeHtml(info.license)} (siehe „Open-Source-Lizenzen")</span>
      </div>
    </div>`;
  void runUpdateCheck(false);
}

async function runUpdateCheck(manual: boolean): Promise<void> {
  if (!manual && updateChecked) return;
  updateChecked = true;

  const cardBtn = el<HTMLButtonElement>("#update-available");
  const barBtn = el<HTMLButtonElement>("#titlebar-update");
  const status = el("#update-msg");
  if (manual) status.textContent = "Suche nach Updates …";

  const res = await api.checkForUpdate();

  if (res.ok && res.updateAvailable && res.latestVersion) {
    const url = res.releaseUrl ?? `${aboutRepoUrl}/releases/latest`;
    for (const b of [cardBtn, barBtn]) {
      b.textContent = `Update verfügbar: ${res.latestVersion}`;
      b.dataset.url = url;
      b.classList.remove("hidden");
    }
    status.textContent = `Neue Version ${res.latestVersion} verfügbar (installiert: ${res.currentVersion}).`;
    return;
  }

  // Kein Update oder Fehler: beide Buttons ausblenden. Der automatische
  // Hintergrund-Check bleibt bei Fehlern still (Offline-First: kein Nörgeln).
  cardBtn.classList.add("hidden");
  barBtn.classList.add("hidden");
  status.textContent = !res.ok
    ? manual
      ? (res.error ?? "Update-Prüfung nicht möglich.")
      : ""
    : manual
      ? `GoBDesk ist aktuell (Version ${res.currentVersion}).`
      : "";
}

// --- Rechnungen -----------------------------------------------------------

let taxRates: TaxRate[] = [];
let isKleinunternehmer = false;
let editingExpenseId: number | null = null;
/** Dokument, das nach dem Anlegen der Ausgabe automatisch verknüpft wird
 *  (Übernahme einer empfangenen E-Rechnung als Ausgabe). */
let pendingExpenseDocId: number | null = null;

const STATUS: Record<string, string> = {
  draft: "Entwurf",
  issued: "Festgeschrieben",
  cancelled: "Storniert",
};

let currentInvoiceId: number | null = null;
let editingInvoiceId: number | null = null;

const PAYMENT_STATUS: Record<string, string> = {
  offen: "Offen",
  teilweise: "Teilweise bezahlt",
  bezahlt: "Bezahlt",
};

/** Status-Badge inkl. Storno-Fällen (Stornobeleg bzw. storniertes Original). */
function statusBadge(i: InvoiceListItem): string {
  if (i.cancels_invoice_id != null && i.status === "issued") {
    return `<span class="badge badge-cancelled">Storno</span>`;
  }
  return `<span class="badge badge-${i.status}">${STATUS[i.status] ?? escapeHtml(i.status)}</span>`;
}

function paymentBadge(i: InvoiceListItem): string {
  // Kein Zahlungsstatus für Stornobelege (negatives Brutto gälte sofort als „bezahlt").
  if (i.status !== "issued" || i.gross_total_cents == null || i.cancels_invoice_id != null) return "";
  if (i.paid_cents >= i.gross_total_cents) return ' <span class="badge badge-paid">bezahlt</span>';
  if (i.paid_cents > 0) return ' <span class="badge badge-draft">teilweise</span>';
  return ' <span class="badge badge-open">offen</span>';
}

function invoiceActions(i: InvoiceListItem): string {
  if (i.status === "draft") {
    return `<button class="link" data-edit-draft="${i.id}">Bearbeiten</button> <button class="link" data-issue="${i.id}">Festschreiben</button>`;
  }
  const parts = [`<button class="link" data-open="${i.id}">Öffnen</button>`];
  if (i.has_pdf) parts.push(`<button class="link" data-pdf="${i.id}">PDF</button>`);
  return parts.join(" ");
}

async function ensureInvoiceFilterCustomers(): Promise<void> {
  const sel = el<HTMLSelectElement>("#inv-filter-customer");
  const current = sel.value;
  const customers = await api.listCustomers();
  sel.innerHTML =
    `<option value="">Alle</option>` +
    customers
      .map((c) => `<option value="${c.id}">${escapeHtml(c.company_name) || "—"}</option>`)
      .join("");
  sel.value = current;
}

function currentInvoiceFilter(): InvoiceFilter {
  return {
    customerId: Number(el<HTMLSelectElement>("#inv-filter-customer").value) || null,
    from: el<HTMLInputElement>("#inv-filter-from").value || null,
    to: el<HTMLInputElement>("#inv-filter-to").value || null,
  };
}

async function renderInvoices(): Promise<void> {
  await ensureInvoiceFilterCustomers();
  const invoices = await api.listInvoices(currentInvoiceFilter());
  el("#invoices-list").innerHTML =
    invoices.length === 0
      ? `<tr>
          <td colspan="6" class="table-empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M21 9H3"/><path d="M21 15H3"/><path d="M12 3v18"/></svg>
            <div class="title">Keine Rechnungen vorhanden</div>
            <div class="desc">Erstelle eine neue Rechnung über die Schaltfläche oben rechts.</div>
          </td>
         </tr>`
      : invoices
          .map(
            (i) => `<tr>
              <td>${escapeHtml(i.invoice_number) || "—"}</td>
              <td class="nowrap">${fmtDate(i.issue_date)}</td>
              <td>${escapeHtml(i.customer_name)}</td>
              <td class="nowrap">${statusBadge(i)}${paymentBadge(i)}</td>
              <td class="num">${i.gross_total_cents != null ? eur(i.gross_total_cents) : "—"}</td>
              <td class="nowrap">${invoiceActions(i)}</td>
            </tr>`,
          )
          .join("");
}

function resetInvoiceView(): void {
  el("#invoice-detail").classList.add("hidden");
  el("#invoice-editor").classList.add("hidden");
  el("#invoice-list-card").classList.remove("hidden");
}

async function openInvoiceDetail(id: number): Promise<void> {
  const det = await api.getInvoice(id);
  if (!det) return;
  currentInvoiceId = id;
  renderInvoiceDetail(det);
  await renderLinkedDocuments("invoice", id, "#invoice-documents");
  await renderInvoiceJournal(id);
  el("#invoice-list-card").classList.add("hidden");
  el("#invoice-editor").classList.add("hidden");
  el("#invoice-detail").classList.remove("hidden");
}

/** Rendert die an ein Ziel verknüpften Dokumente (mit „Öffnen") in einen Container. */
async function renderLinkedDocuments(
  targetType: "invoice" | "expense" | "customer",
  targetId: number,
  container: string,
): Promise<void> {
  const docs = await api.listDocumentsForTarget(targetType, targetId);
  el(container).innerHTML = docs.length
    ? docs
        .map(
          (d) =>
            `<div class="link-chip">${escapeHtml(d.title)}
              <button class="link" data-open-linked-doc="${d.id}">öffnen</button></div>`,
        )
        .join("")
    : `<span class="muted">Keine verknüpften Dokumente.</span>`;
}

function backToInvoiceList(): void {
  currentInvoiceId = null;
  el("#invoice-detail").classList.add("hidden");
  el("#invoice-list-card").classList.remove("hidden");
  void renderInvoices();
}

function renderInvoiceDetail(det: InvoiceDetail): void {
  el("#invoice-detail-title").textContent = `Rechnung ${det.invoice_number ?? "(Entwurf)"} — ${
    det.customer_name ?? ""
  }`;
  el("#invoice-detail-meta").innerHTML =
    `Datum: ${fmtDate(det.issue_date)} · Leistungsdatum: ${fmtDate(det.service_date)} · Status: ${STATUS[det.status] ?? escapeHtml(det.status)}` +
    (det.order_number ? ` · Auftrag: ${escapeHtml(det.order_number)}` : "") +
    (det.cancelled_by_invoice_id != null
      ? ` · <span class="badge badge-cancelled">Storniert durch <button class="link" data-open-invoice="${det.cancelled_by_invoice_id}">${escapeHtml(det.cancelled_by_number ?? "Stornobeleg")}</button></span>`
      : "") +
    (det.cancels_invoice_id != null
      ? ` · <span class="badge badge-cancelled">Storno zu <button class="link" data-open-invoice="${det.cancels_invoice_id}">${escapeHtml(det.cancels_number ?? "Original")}</button></span>`
      : "");

  el("#invoice-detail-items").innerHTML = det.items
    .map(
      (it) => `<tr>
        <td>${it.position}</td>
        <td>${escapeHtml(it.description)}${adjDetail(it.discount, "abzgl. Rabatt", "discount")}${adjDetail(it.surcharge, "zzgl. Aufpreis", "surcharge")}</td>
        <td class="num">${(it.quantity_milli / 1000).toLocaleString("de-DE")}</td>
        <td class="num">${eur(it.unit_price_net_cents)}</td>
        <td class="num">${it.tax_rate_bp / 100} %</td>
        <td class="num">${it.line_net_cents != null ? eur(it.line_net_cents) : "—"}</td>
      </tr>`,
    )
    .join("");

  el("#invoice-detail-totals").innerHTML =
    det.gross_total_cents != null
      ? (det.discount ? `<span class="adj-pill adj-pill-discount">Rechnungs-Rabatt: −${adjText(det.discount)}</span> ` : "") +
        `Netto ${eur(det.net_total_cents ?? 0)} · USt ${eur(det.tax_total_cents ?? 0)} · <strong>Brutto ${eur(det.gross_total_cents)}</strong>`
      : "";
  const actionButtons: string[] = [];
  if (det.has_pdf) {
    actionButtons.push(
      `<button class="secondary small" id="detail-pdf-btn">PDF öffnen</button>`,
      `<button class="secondary small" id="detail-validate-btn">Prüfen (EN 16931)</button>`,
    );
  }
  // Storno nur für festgeschriebene, noch nicht stornierte Original-Rechnungen.
  if (det.status === "issued" && det.cancelled_by_invoice_id == null && det.cancels_invoice_id == null) {
    actionButtons.push(`<button class="danger small" id="detail-cancel-btn">Stornieren…</button>`);
  }
  el("#invoice-detail-pdf").innerHTML = actionButtons.join(" ");
  el("#invoice-validation").innerHTML = "";

  el("#payment-status").innerHTML = `<span>${PAYMENT_STATUS[det.payment_status]}</span><strong>Bezahlt ${eur(
    det.paid_cents,
  )} · Offen ${eur(det.remaining_cents)}</strong>`;
  el("#payments-list").innerHTML =
    det.payments.length === 0
      ? `<tr><td colspan="4" class="muted">Noch keine Zahlungen.</td></tr>`
      : det.payments
          .map(
            (p) => `<tr>
              <td class="nowrap">${fmtDate(p.paid_at)}</td>
              <td class="num">${eur(p.amount_cents)}</td>
              <td>${escapeHtml(p.note)}</td>
              <td><button class="link" data-del-payment="${p.id}">Löschen</button></td>
            </tr>`,
          )
          .join("");

  const form = el<HTMLFormElement>("#payment-form");
  (form.elements.namedItem("paid_at") as HTMLInputElement).value = today();
  (form.elements.namedItem("amount") as HTMLInputElement).value = (det.remaining_cents / 100).toFixed(2);
  (form.elements.namedItem("note") as HTMLInputElement).value = "";
  el("#payment-error").textContent = "";
}

function addItemRow(prefill?: InvoiceItemDetail): void {
  const taxSel = taxRates
    .map((r) => {
      const selected = prefill ? prefill.tax_rate_bp === r.rate_bp : r.is_default === 1;
      return `<option value="${r.rate_bp}" ${selected ? "selected" : ""}>${escapeHtml(r.name)}</option>`;
    })
    .join("");
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>
      <input class="li-desc" type="text" placeholder="Leistung / Artikel" value="${prefill ? escapeHtml(prefill.description) : ""}" />
      <div class="li-adjust">
        ${adjInputs("li-disc", "Rabatt", "li-adj-discount", prefill?.discount)}
        ${adjInputs("li-surch", "Aufpreis", "li-adj-surcharge", prefill?.surcharge)}
      </div>
    </td>
    <td><input class="li-qty" type="number" step="0.001" value="${prefill ? prefill.quantity_milli / 1000 : 1}" /></td>
    <td><input class="li-unit" type="text" value="${prefill ? escapeHtml(prefill.unit) : "Stk"}" /></td>
    <td><input class="li-price" type="number" step="0.01" value="${prefill ? (prefill.unit_price_net_cents / 100).toFixed(2) : 0}" /></td>
    <td><select class="li-tax">${taxSel}</select></td>
    <td><button type="button" class="link li-remove" title="Position entfernen">✕</button></td>`;
  el("#inv-items").appendChild(tr);
  recomputeTotals();
}

/** Kompakte Zu-/Abschlag-Eingabe (Typ %/€ + Wert + Grund) für eine Position. */
function adjInputs(cls: string, label: string, modifierClass: string, a?: LineAdjustment | null): string {
  const val = a ? String(a.value / 100) : "";
  return `<span class="li-adj ${modifierClass}">
    <span class="li-adj-badge">${label}</span>
    <span class="li-adj-controls">
      <select class="${cls}-type">
        <option value="">–</option>
        <option value="percent" ${a?.type === "percent" ? "selected" : ""}>%</option>
        <option value="amount" ${a?.type === "amount" ? "selected" : ""}>€</option>
      </select>
      <input class="${cls}-val" type="number" step="0.01" min="0" placeholder="Wert" value="${val}" />
      <input class="${cls}-reason" type="text" placeholder="Grund" value="${a?.reason ? escapeHtml(a.reason) : ""}" />
    </span>
  </span>`;
}

/** Liest einen Zu-/Abschlag aus drei Feldern (Typ %/€ + Wert + Grund) oder null.
 *  toCents skaliert ×100 – passt für Prozent (30 → 3000 bp) und Betrag (50 → 5000 ct). */
function readAdj(scope: ParentNode, cls: string): LineAdjustment | null {
  const type = scope.querySelector<HTMLSelectElement>(`.${cls}-type`)?.value;
  const raw = scope.querySelector<HTMLInputElement>(`.${cls}-val`)?.value.trim() ?? "";
  if ((type !== "percent" && type !== "amount") || raw === "") return null;
  const value = toCents(raw);
  if (value <= 0) return null;
  const reason = scope.querySelector<HTMLInputElement>(`.${cls}-reason`)?.value.trim() || null;
  return { type, value, reason };
}

/** Rechnungsweiter Rabatt aus dem Summenbereich (oder null). */
function readInvoiceDiscount(): LineAdjustment | null {
  const type = el<HTMLSelectElement>("#inv-disc-type").value;
  const raw = el<HTMLInputElement>("#inv-disc-val").value.trim();
  if ((type !== "percent" && type !== "amount") || raw === "") return null;
  const value = toCents(raw);
  if (value <= 0) return null;
  const reason = el<HTMLInputElement>("#inv-disc-reason").value.trim() || null;
  return { type, value, reason };
}

/** Kurztext eines Zu-/Abschlags für die Anzeige, z. B. „30 % (Animation)". */
function adjText(a: LineAdjustment): string {
  const v = a.type === "percent" ? `${a.value / 100} %` : eur(a.value);
  return a.reason ? `${v} (${escapeHtml(a.reason)})` : v;
}

/** Zu-/Abschlag-Zeile für die (festgeschriebene) Detailansicht, oder leer. */
function adjDetail(a: LineAdjustment | null, label: string, type: "discount" | "surcharge" = "discount"): string {
  if (!a) return "";
  const cls = type === "discount" ? "adj-pill-discount" : "adj-pill-surcharge";
  const prefix = type === "discount" ? "−" : "+";
  return `<span class="adj-pill ${cls}">${label}: ${prefix}${adjText(a)}</span>`;
}

function readInvoiceLines(): InvoiceLineInput[] {
  const lines: InvoiceLineInput[] = [];
  document.querySelectorAll<HTMLTableRowElement>("#inv-items tr").forEach((row) => {
    const desc = row.querySelector<HTMLInputElement>(".li-desc")!.value.trim();
    if (desc.length === 0) return;
    lines.push({
      description: desc,
      quantity_milli: toMilli(row.querySelector<HTMLInputElement>(".li-qty")!.value),
      unit: row.querySelector<HTMLInputElement>(".li-unit")!.value.trim() || "Stk",
      unit_price_net_cents: toCents(row.querySelector<HTMLInputElement>(".li-price")!.value),
      tax_rate_bp: Number(row.querySelector<HTMLSelectElement>(".li-tax")!.value),
      discount: readAdj(row, "li-disc"),
      surcharge: readAdj(row, "li-surch"),
    });
  });
  return lines;
}

function recomputeTotals(): void {
  const li: LineInput[] = readInvoiceLines().map((l) => ({
    quantityMilli: l.quantity_milli,
    unitPriceNetCents: l.unit_price_net_cents,
    taxRateBp: l.tax_rate_bp,
    discount: l.discount,
    surcharge: l.surcharge,
  }));
  const t = computeInvoiceTotals(li, isKleinunternehmer, readInvoiceDiscount());
  const parts: string[] = [];
  if (t.invoiceDiscountCents > 0) {
    parts.push(`Zwischensumme ${eur(t.lineNetSumCents)}`, `<span class="ok">Rabatt −${eur(t.invoiceDiscountCents)}</span>`);
  }
  parts.push(
    `Netto ${eur(t.netTotalCents)}`,
    `USt ${eur(t.taxTotalCents)}`,
    `<strong>Brutto ${eur(t.grossTotalCents)}</strong>`,
  );
  el("#inv-totals").innerHTML = parts.join(" · ");
}

function closeInvoiceEditor(): void {
  el("#invoice-editor").classList.add("hidden");
  editingInvoiceId = null;
  hideInvoicePreview();
}

async function openInvoiceEditor(
  draft: InvoiceDetail | null,
  prefill?: { customer_id: number | null; order_id: number | null },
): Promise<void> {
  const [customers, rates, settings, orderOptions] = await Promise.all([
    api.listCustomers(),
    api.listTaxRates(),
    api.getSettings(),
    api.listOrderOptions(),
  ]);
  taxRates = rates;
  isKleinunternehmer = Boolean(settings?.is_kleinunternehmer);
  editingInvoiceId = draft?.id ?? null;
  el("#invoice-editor-title").textContent = draft ? "Entwurf bearbeiten" : "Neue Rechnung";

  if (customers.length === 0 && !draft) {
    el("#invoice-error").textContent = "Bitte zuerst einen Kunden anlegen.";
    el("#invoice-editor").classList.remove("hidden");
    return;
  }

  el<HTMLSelectElement>("#inv-customer").innerHTML = customers
    .map(
      (c) =>
        `<option value="${c.id}" ${draft?.customer_id === c.id ? "selected" : ""}>${escapeHtml(c.company_name) || "—"}</option>`,
    )
    .join("");
  if (prefill?.customer_id != null) {
    el<HTMLSelectElement>("#inv-customer").value = String(prefill.customer_id);
  }
  fillOrderSelect(
    el<HTMLSelectElement>("#inv-order"),
    orderOptions,
    draft?.order_id ?? prefill?.order_id ?? null,
  );
  el<HTMLInputElement>("#inv-issue").value = draft?.issue_date ?? today();
  el<HTMLInputElement>("#inv-service").value = draft?.service_date ?? today();
  el<HTMLInputElement>("#inv-terms").value =
    draft?.notes ?? "Zahlbar innerhalb von 14 Tagen ohne Abzug.";
  el<HTMLSelectElement>("#inv-disc-type").value = draft?.discount?.type ?? "";
  el<HTMLInputElement>("#inv-disc-val").value = draft?.discount
    ? String(draft.discount.value / 100)
    : "";
  el<HTMLInputElement>("#inv-disc-reason").value = draft?.discount?.reason ?? "";
  el("#inv-items").innerHTML = "";
  el("#invoice-error").textContent = "";
  hideInvoicePreview();
  if (draft && draft.items.length > 0) draft.items.forEach((it) => addItemRow(it));
  else addItemRow();
  el("#invoice-editor").classList.remove("hidden");
}

function collectDraft(): DraftInvoiceInput {
  const lines = readInvoiceLines();
  if (lines.length === 0) throw new Error("Bitte mindestens eine Position mit Beschreibung angeben.");
  return {
    customer_id: Number(el<HTMLSelectElement>("#inv-customer").value),
    issue_date: el<HTMLInputElement>("#inv-issue").value,
    service_date: el<HTMLInputElement>("#inv-service").value,
    payment_terms: el<HTMLInputElement>("#inv-terms").value.trim() || null,
    order_id: Number(el<HTMLSelectElement>("#inv-order").value) || null,
    discount: readInvoiceDiscount(),
    lines,
  };
}

async function saveDraft(): Promise<void> {
  try {
    const input = collectDraft();
    if (editingInvoiceId) await api.updateDraftInvoice(editingInvoiceId, input);
    else await api.createDraftInvoice(input);
    closeInvoiceEditor();
    await renderInvoices();
  } catch (err) {
    el("#invoice-error").textContent = msg(err);
  }
}

async function issueNow(): Promise<void> {
  try {
    const input = collectDraft();
    let id: number;
    if (editingInvoiceId) {
      await api.updateDraftInvoice(editingInvoiceId, input);
      id = editingInvoiceId;
    } else {
      id = await api.createDraftInvoice(input);
    }
    const res = await api.issueInvoice(id);
    closeInvoiceEditor();
    await renderInvoices();
    if (res.pdf_path) await api.openArtifact(id, "pdf");
  } catch (err) {
    el("#invoice-error").textContent = msg(err);
    await renderInvoices();
  }
}

/** Editor-Zustand ohne Positions-Pflicht (für die Vorschau). */
function collectDraftLenient(): DraftInvoiceInput {
  return {
    customer_id: Number(el<HTMLSelectElement>("#inv-customer").value) || 0,
    issue_date: el<HTMLInputElement>("#inv-issue").value,
    service_date: el<HTMLInputElement>("#inv-service").value,
    payment_terms: el<HTMLInputElement>("#inv-terms").value.trim() || null,
    order_id: Number(el<HTMLSelectElement>("#inv-order").value) || null,
    discount: readInvoiceDiscount(),
    lines: readInvoiceLines(),
  };
}

let previewUrl: string | null = null;

async function previewDraft(): Promise<void> {
  const frame = el<HTMLIFrameElement>("#invoice-preview");
  try {
    el("#invoice-error").textContent = "";
    const bytes = await api.previewInvoice(collectDraftLenient());
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    const blob = new Blob([buf], { type: "application/pdf" });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    frame.src = previewUrl + "#toolbar=0&navpanes=0&pagemode=none&view=FitH";
    frame.classList.remove("hidden");
    const btn = el("#preview-invoice");
    if (btn) {
      btn.textContent = "Vorschau ausblenden";
      btn.classList.add("active");
    }
  } catch (err) {
    el("#invoice-error").textContent = msg(err);
  }
}

function hideInvoicePreview(): void {
  const frame = el<HTMLIFrameElement>("#invoice-preview");
  frame.classList.add("hidden");
  frame.removeAttribute("src");
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  const btn = el("#preview-invoice");
  if (btn) {
    btn.textContent = "Vorschau";
    btn.classList.remove("active");
  }
}

async function toggleDraftPreview(): Promise<void> {
  const frame = el<HTMLIFrameElement>("#invoice-preview");
  if (!frame.classList.contains("hidden")) {
    hideInvoicePreview();
  } else {
    await previewDraft();
  }
}

// --- EÜR + Ausgaben -------------------------------------------------------

const manualEuerYears = new Set<number>();

async function initYearSelect(): Promise<void> {
  const sel = el<HTMLSelectElement>("#euer-year");
  const prev = sel.value;
  const years = await api.listEuerYears();
  const set = new Set<number>([...years, new Date().getFullYear(), ...manualEuerYears]);
  const sorted = [...set].sort((a, b) => b - a);
  sel.innerHTML = sorted.map((y) => `<option value="${y}">${y}</option>`).join("");
  sel.value = prev && set.has(Number(prev)) ? prev : String(sorted[0]);
}

async function addEuerYear(): Promise<void> {
  const input = el<HTMLInputElement>("#euer-year-add");
  const y = Number(input.value);
  if (!y || y < 2000 || y > 2100) return;
  manualEuerYears.add(y);
  input.value = "";
  await initYearSelect();
  el<HTMLSelectElement>("#euer-year").value = String(y);
  await renderEuerForSelectedYear();
}

async function renderEuer(): Promise<void> {
  await initYearSelect();
  await renderEuerForSelectedYear();
}

async function renderEuerForSelectedYear(): Promise<void> {
  const year = Number(el<HTMLSelectElement>("#euer-year").value);
  const [report, expenses] = await Promise.all([api.euerReport(year), api.listExpenses(year)]);

  const lines: string[] = [
    `<div class="euer-line"><span>Betriebseinnahmen (netto)</span><strong>${eur(report.income_net_cents)}</strong></div>`,
  ];
  if (!report.is_kleinunternehmer) {
    lines.push(
      `<div class="euer-line sub"><span>davon USt vereinnahmt</span><span>${eur(report.ust_collected_cents)}</span></div>`,
    );
  }
  lines.push(
    `<div class="euer-line"><span>Betriebsausgaben</span><strong>−${eur(report.expenses_total_cents)}</strong></div>`,
  );
  if (!report.is_kleinunternehmer) {
    lines.push(
      `<div class="euer-line sub"><span>davon Vorsteuer</span><span>${eur(report.vorsteuer_cents)}</span></div>`,
    );
  }

  // Gewinnspanne Visualisierung
  if (report.income_net_cents > 0) {
    const expensePercent = Math.min(100, Math.round((report.expenses_total_cents / report.income_net_cents) * 100));
    lines.push(`
      <div class="euer-progress-container" title="Gewinnspanne: ${100 - expensePercent}%">
        <div class="euer-progress-bar" style="width: ${100 - expensePercent}%"></div>
      </div>
    `);
  }

  lines.push(
    `<div class="euer-line total"><span>Gewinn / Verlust</span><strong>${eur(report.profit_cents)}</strong></div>`,
  );
  if (!report.is_kleinunternehmer) {
    lines.push(
      `<div class="euer-line"><span>USt-Zahllast (Umsatzsteuer − Vorsteuer)</span><strong>${eur(report.ust_zahllast_cents)}</strong></div>`,
    );
  }

  const cats = report.expenses.length
    ? `<div class="euer-cats"><div class="euer-cats-title">Ausgaben nach Kategorie</div>${report.expenses
        .map(
          (e) =>
            `<div class="euer-line sub"><span>${escapeHtml(e.category)}</span><span>${eur(e.amount_cents)}</span></div>`,
        )
        .join("")}</div>`
    : "";

  el("#euer-summary").innerHTML =
    `<h2>Auswertung ${year}</h2>${lines.join("")}${cats}` +
    `<p class="hint">Einnahmen nach Zahlungseingang (Zuflussprinzip) – Teilzahlungen zählen anteilig im Jahr ihres Eingangs; Ausgaben nach Zahlungs-/Belegdatum.</p>`;

  el("#expenses-list").innerHTML =
    expenses.length === 0
      ? `<tr>
          <td colspan="8" class="table-empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon"><line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/></svg>
            <div class="title">Keine Ausgaben erfasst</div>
            <div class="desc">Erfasse Ausgaben für das Jahr ${year} über die Schaltfläche oben rechts.</div>
          </td>
         </tr>`
      : expenses
          .map(
            (x) => `<tr>
              <td>${fmtDate(x.expense_date)}</td>
              <td>${escapeHtml(x.description)}</td>
              <td>${escapeHtml(x.vendor)}</td>
              <td>${escapeHtml(x.category_name)}</td>
              <td class="num">${x.deductible_permille / 10} %</td>
              <td class="num">${eur(x.net_cents)}</td>
              <td class="num">${eur(x.gross_cents)}</td>
              <td><button class="link" data-edit-expense="${x.id}">Bearbeiten</button></td>
            </tr>`,
          )
          .join("");
}

/** Öffnet das Ausgabenformular – mit `id` zum Bearbeiten, ohne `id` als
 *  vorbefüllte Neuanlage (z. B. Übernahme aus einer empfangenen E-Rechnung). */
async function openExpenseForm(
  detail: (Partial<ExpenseDetail> & { id?: number }) | null,
): Promise<void> {
  const [cats, rates, orderOptions] = await Promise.all([
    api.listEuerCategories(),
    api.listTaxRates(),
    api.listOrderOptions(),
  ]);
  taxRates = rates;
  editingExpenseId = detail?.id ?? null;
  const form = el<HTMLFormElement>("#expense-form");
  const field = (n: string): HTMLInputElement | HTMLSelectElement =>
    form.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement;
  (field("category_id") as HTMLSelectElement).innerHTML = cats
    .map(
      (c: EuerCategory) =>
        `<option value="${c.id}" ${detail?.category_id === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`,
    )
    .join("");
  (field("tax") as HTMLSelectElement).innerHTML = taxRates
    .map((r) => {
      const selected =
        detail?.tax_rate_bp != null ? detail.tax_rate_bp === r.rate_bp : r.is_default === 1;
      return `<option value="${r.rate_bp}" ${selected ? "selected" : ""}>${escapeHtml(r.name)}</option>`;
    })
    .join("");
  (field("expense_date") as HTMLInputElement).value = detail?.expense_date ?? today();
  (field("description") as HTMLInputElement).value = detail?.description ?? "";
  (field("vendor") as HTMLInputElement).value = detail?.vendor ?? "";
  (field("gross") as HTMLInputElement).value =
    detail?.gross_cents != null ? (detail.gross_cents / 100).toFixed(2) : "0";
  (field("deductible") as HTMLInputElement).value =
    detail?.deductible_permille != null ? String(detail.deductible_permille / 10) : "100";
  fillOrderSelect(field("order_id") as HTMLSelectElement, orderOptions, detail?.order_id ?? null);
  el("#expense-form-title").textContent = editingExpenseId ? "Ausgabe bearbeiten" : "Neue Ausgabe";
  el("#expense-error").textContent = "";

  if (editingExpenseId != null) {
    await renderLinkedDocuments("expense", editingExpenseId, "#expense-documents");
    el("#expense-documents-wrap").classList.remove("hidden");
  } else {
    el("#expense-documents-wrap").classList.add("hidden");
  }

  form.classList.remove("hidden");
}

async function submitExpense(ev: Event): Promise<void> {
  ev.preventDefault();
  const form = el<HTMLFormElement>("#expense-form");
  const value = (n: string): string =>
    (form.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement).value;
  const input = {
    expense_date: value("expense_date"),
    payment_date: value("expense_date"),
    description: value("description"),
    vendor: value("vendor") || null,
    category_id: Number(value("category_id")),
    gross_cents: toCents(value("gross")),
    tax_rate_bp: Number(value("tax")),
    deductible_permille: Math.round((parseFloat(value("deductible").replace(",", ".")) || 100) * 10),
    order_id: value("order_id") ? Number(value("order_id")) : null,
  };
  try {
    if (editingExpenseId) {
      await api.updateExpense(editingExpenseId, input);
    } else {
      const newId = await api.createExpense(input);
      // Übernahme aus E-Rechnung: Beleg automatisch mit der Ausgabe verknüpfen.
      if (pendingExpenseDocId != null) {
        await api.linkDocument(pendingExpenseDocId, "expense", newId);
      }
    }
    pendingExpenseDocId = null;
    form.classList.add("hidden");
    await renderEuer();
  } catch (err) {
    el("#expense-error").textContent = msg(err);
  }
}

// --- Aufträge -------------------------------------------------------------

const ORDER_STATUS: Record<string, string> = {
  offen: "Offen",
  in_arbeit: "In Arbeit",
  abgeschlossen: "Abgeschlossen",
  storniert: "Storniert",
};

let editingOrderId: number | null = null;
let currentOrder: OrderDetail | null = null;

function fillOrderSelect(
  select: HTMLSelectElement,
  options: OrderOption[],
  selected: number | null | undefined,
): void {
  select.innerHTML =
    `<option value="">— ohne —</option>` +
    options.map((o) => `<option value="${o.id}">${escapeHtml(o.label)}</option>`).join("");
  select.value = selected != null ? String(selected) : "";
}

let orderSearchTimer: number | undefined;

async function renderOrders(): Promise<void> {
  const search = el<HTMLInputElement>("#order-search").value;
  const status = el<HTMLSelectElement>("#order-status-filter").value;
  const orders = await api.listOrders({ search, status: (status || null) as OrderStatus | null });
  el("#orders-list").innerHTML =
    orders.length === 0
      ? `<tr>
          <td colspan="6" class="table-empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon"><path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/></svg>
            <div class="title">${search || status ? "Keine Aufträge gefunden" : "Keine Aufträge vorhanden"}</div>
            <div class="desc">${search || status ? "Passe deine Filter oder Suche an." : "Lege einen neuen Auftrag über die Schaltfläche oben rechts an."}</div>
          </td>
         </tr>`
      : orders
          .map(
            (o: OrderListItem) => `<tr>
              <td class="nowrap"><strong>${escapeHtml(o.order_number)}</strong></td>
              <td>${escapeHtml(o.title)}</td>
              <td>${escapeHtml(o.customer_name) || "—"}</td>
              <td class="nowrap"><span class="badge badge-${o.status === 'offen' ? 'open' : o.status === 'in_arbeit' ? 'issued' : o.status === 'abgeschlossen' ? 'paid' : 'cancelled'}">${ORDER_STATUS[o.status] ?? escapeHtml(o.status)}</span></td>
              <td class="nowrap"><span class="muted">${o.invoice_count} R · ${o.document_count} D · ${o.expense_count} A</span></td>
              <td class="num"><button class="link" data-order-detail="${o.id}">Öffnen</button></td>
            </tr>`,
          )
          .join("");
}

async function openOrderForm(detail: OrderDetail | null): Promise<void> {
  const customers = await api.listCustomers();
  editingOrderId = detail?.id ?? null;
  const form = el<HTMLFormElement>("#order-form");
  const field = (n: string): HTMLInputElement | HTMLSelectElement =>
    form.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement;
  (field("customer_id") as HTMLSelectElement).innerHTML =
    `<option value="">— ohne —</option>` +
    customers.map((c) => `<option value="${c.id}">${escapeHtml(c.company_name) || "—"}</option>`).join("");
  field("order_number").value = detail?.order_number ?? (await api.suggestOrderNumber());
  field("title").value = detail?.title ?? "";
  (field("customer_id") as HTMLSelectElement).value =
    detail?.customer_id != null ? String(detail.customer_id) : "";
  field("order_date").value = detail?.order_date ?? today();
  (field("status") as HTMLSelectElement).value = detail?.status ?? "offen";
  field("notes").value = detail?.notes ?? "";
  el("#order-form-title").textContent = detail ? "Auftrag bearbeiten" : "Neuer Auftrag";
  el("#order-error").textContent = "";
  el("#order-detail").classList.add("hidden");
  el("#order-list-card").classList.remove("hidden");
  form.classList.remove("hidden");
}

function readOrderForm(): OrderInput {
  const form = el<HTMLFormElement>("#order-form");
  const v = (n: string): string =>
    (form.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
  return {
    order_number: v("order_number").trim() || null,
    customer_id: v("customer_id") ? Number(v("customer_id")) : null,
    title: v("title"),
    status: (v("status") || "offen") as OrderStatus,
    order_date: v("order_date") || null,
    notes: v("notes").trim() || null,
  };
}

async function submitOrder(ev: Event): Promise<void> {
  ev.preventDefault();
  try {
    if (editingOrderId) await api.updateOrder(editingOrderId, readOrderForm());
    else await api.createOrder(readOrderForm());
    el("#order-form").classList.add("hidden");
    await renderOrders();
  } catch (err) {
    el("#order-error").textContent = msg(err);
  }
}

async function openOrderDetail(id: number): Promise<void> {
  const order = await api.getOrder(id);
  if (!order) return;
  currentOrder = order;
  el("#order-detail-title").textContent = `${order.order_number} — ${order.title}`;
  el("#order-detail-info").innerHTML =
    `Kunde: ${escapeHtml(order.customer_name) || "—"} · Status: ${ORDER_STATUS[order.status] ?? escapeHtml(order.status)}` +
    (order.order_date ? ` · ${fmtDate(order.order_date)}` : "") +
    (order.notes ? `<br /><span class="muted">${escapeHtml(order.notes)}</span>` : "");

  el("#order-invoices").innerHTML = order.invoices.length
    ? order.invoices
        .map(
          (i) => `<div class="link-chip">${escapeHtml(i.invoice_number) || "Entwurf"} · ${eur(i.gross_total_cents ?? 0)}
            ${
              i.status === "draft"
                ? `<span class="muted">Entwurf</span>`
                : `${
                    i.status === "cancelled"
                      ? `<span class="badge badge-cancelled">Storniert</span> `
                      : i.cancels_invoice_id != null
                        ? `<span class="badge badge-cancelled">Storno</span> `
                        : ""
                  }<button class="link" data-order-open-invoice="${i.id}">öffnen</button>`
            }</div>`,
        )
        .join("")
    : `<span class="muted">Keine Rechnungen.</span>`;

  el("#order-documents").innerHTML = order.documents.length
    ? order.documents
        .map(
          (d) => `<div class="link-chip">${escapeHtml(d.title)}
            <button class="link" data-order-open-doc="${d.id}">öffnen</button></div>`,
        )
        .join("")
    : `<span class="muted">Keine Dokumente.</span>`;

  el("#order-expenses").innerHTML = order.expenses.length
    ? order.expenses.map((e) => `<div class="link-chip">${escapeHtml(e.description)} · ${eur(e.gross_cents)}</div>`).join("")
    : `<span class="muted">Keine Ausgaben.</span>`;

  el("#order-list-card").classList.add("hidden");
  el("#order-detail").classList.remove("hidden");
}

function backToOrders(): void {
  el("#order-detail").classList.add("hidden");
  el("#order-list-card").classList.remove("hidden");
  void renderOrders();
}

async function addInvoiceForOrder(): Promise<void> {
  if (!currentOrder) return;
  showView("invoices");
  await openInvoiceEditor(null, { customer_id: currentOrder.customer_id, order_id: currentOrder.id });
}

async function importDocForOrder(): Promise<void> {
  if (!currentOrder) return;
  const res = await api.importDocumentsForOrder(currentOrder.id);
  if (!res.canceled) await openOrderDetail(currentOrder.id);
}

async function deleteCurrentOrder(): Promise<void> {
  if (!currentOrder) return;
  const ok = await confirmModal({
    title: "Auftrag löschen?",
    message:
      "Der Auftrag wird gelöscht; verknüpfte Rechnungen/Dokumente/Ausgaben bleiben erhalten " +
      "(nur die Zuordnung entfällt). Festgeschriebene Rechnungen verhindern das Löschen.",
    okLabel: "Löschen",
  });
  if (!ok) return;
  try {
    await api.deleteOrder(currentOrder.id);
    backToOrders();
  } catch (err) {
    el("#order-detail-info").innerHTML += `<br /><span class="error">${escapeHtml(msg(err))}</span>`;
  }
}

// --- Dokumente ------------------------------------------------------------

let currentDocId: number | null = null;
let docSearchTimer: number | undefined;
let linkTargets: LinkTargets = { invoices: [], expenses: [] };

function docActions(d: DocumentListItem): string {
  return (
    `<button class="link" data-doc-detail="${d.id}">Details</button> ` +
    `<button class="link" data-doc-open="${d.id}">Öffnen</button>`
  );
}

async function ensureDocFilters(): Promise<void> {
  const [types, customers, orders] = await Promise.all([
    api.listDocumentTypes(),
    api.listCustomers(),
    api.listOrderOptions(),
  ]);
  el<HTMLSelectElement>("#doc-filter-type").innerHTML =
    `<option value="">Alle</option>` +
    types.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
  el<HTMLSelectElement>("#doc-filter-customer").innerHTML =
    `<option value="">Alle</option>` +
    customers.map((c) => `<option value="${c.id}">${escapeHtml(c.company_name) || "—"}</option>`).join("");
  el<HTMLSelectElement>("#doc-filter-order").innerHTML =
    `<option value="">Alle</option>` +
    orders.map((o) => `<option value="${o.id}">${escapeHtml(o.label)}</option>`).join("");
}

async function renderDocuments(): Promise<void> {
  const filter: DocumentFilter = {
    search: el<HTMLInputElement>("#doc-search").value,
    typeId: Number(el<HTMLSelectElement>("#doc-filter-type").value) || null,
    customerId: Number(el<HTMLSelectElement>("#doc-filter-customer").value) || null,
    orderId: Number(el<HTMLSelectElement>("#doc-filter-order").value) || null,
    includeArchived: el<HTMLInputElement>("#doc-filter-archived").checked,
  };
  const active = Boolean(filter.search || filter.typeId || filter.customerId || filter.orderId);
  const docs = await api.listDocuments(filter);
  el("#documents-list").innerHTML =
    docs.length === 0
      ? `<tr>
          <td colspan="6" class="table-empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>
            <div class="title">${active ? "Keine Dokumente gefunden" : "Keine Dokumente vorhanden"}</div>
            <div class="desc">${active ? "Passe deine Suchbegriffe oder Filter an." : "Importiere ein neues Dokument über die Schaltfläche oben rechts."}</div>
          </td>
         </tr>`
      : docs
          .map(
            (d) => `<tr>
              <td><strong>${escapeHtml(d.title)}</strong>${d.is_archived ? ' <span class="badge badge-cancelled">Archiv</span>' : ""}</td>
              <td class="nowrap">${escapeHtml(d.type_name) || "—"}</td>
              <td>${escapeHtml(d.customer_name) || "—"}</td>
              <td class="nowrap">${fmtDate(d.doc_date)}</td>
              <td>${(d.tags || "")
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
                .map((t) => `<span class="badge badge-tag">${escapeHtml(t)}</span>`)
                .join("")}</td>
              <td class="num">${docActions(d)}</td>
            </tr>`,
          )
          .join("");
}

async function openDocumentDetail(id: number): Promise<void> {
  const [doc, types, customers, targets, orderOptions] = await Promise.all([
    api.getDocument(id),
    api.listDocumentTypes(),
    api.listCustomers(),
    api.listLinkTargets(),
    api.listOrderOptions(),
  ]);
  if (!doc) return;
  currentDocId = id;
  linkTargets = targets;

  const typeSel = el<HTMLSelectElement>("#document-form [name=document_type_id]");
  typeSel.innerHTML =
    `<option value="">— ohne —</option>` +
    types
      .map((t: DocumentType) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
      .join("");
  typeSel.value = doc.document_type_id != null ? String(doc.document_type_id) : "";

  const custSel = el<HTMLSelectElement>("#document-form [name=customer_id]");
  custSel.innerHTML =
    `<option value="">— ohne —</option>` +
    customers
      .map((c) => `<option value="${c.id}">${escapeHtml(c.company_name) || "—"}</option>`)
      .join("");
  custSel.value = doc.customer_id != null ? String(doc.customer_id) : "";

  fillOrderSelect(el<HTMLSelectElement>("#document-form [name=order_id]"), orderOptions, doc.order_id);

  el<HTMLInputElement>("#document-form [name=title]").value = doc.title;
  el<HTMLInputElement>("#document-form [name=doc_date]").value = doc.doc_date ?? "";
  el<HTMLInputElement>("#document-form [name=tags]").value = doc.tags.join(", ");
  el("#document-error").textContent = "";

  const sizeKb = doc.file_size != null ? `${Math.round(doc.file_size / 1024)} KB · ` : "";
  el("#document-detail-meta").innerHTML =
    `${sizeKb}${escapeHtml(doc.original_filename) || ""}` +
    (doc.is_archived ? ' <span class="badge badge-cancelled">Archiviert</span>' : "") +
    `<br /><span class="muted">Importiert: ${escapeHtml(doc.added_at.slice(0, 10))}</span>`;
  el("#document-detail-title").textContent = doc.title;
  el("#archive-doc").textContent = doc.is_archived ? "Wiederherstellen" : "Archivieren";
  el<HTMLTextAreaElement>("#doc-ocr-text").value = doc.ocr_text ?? "";
  el("#doc-ocr-msg").textContent = "";

  // Empfangene E-Rechnung: erkannte Kerndaten + Übernahme als Ausgabe.
  const inv = doc.einvoice;
  el("#document-einvoice").innerHTML = inv
    ? `<div class="banner banner-warn">🧾 <strong>E-Rechnung erkannt</strong> (${escapeHtml(inv.syntax)})
        · ${inv.number ? `Nr. ${escapeHtml(inv.number)}` : "ohne Nummer"}
        · ${escapeHtml(inv.seller) || "unbekannter Aussteller"}
        · ${fmtDate(inv.issue_date)}
        ${inv.gross_cents != null ? ` · <strong>${eur(inv.gross_cents)}</strong>` : ""}
        ${inv.currency && inv.currency !== "EUR" ? ` (${escapeHtml(inv.currency)}!)` : ""}
        <button class="link" id="einvoice-to-expense">Als Ausgabe übernehmen</button></div>`
    : "";

  renderDocLinks(doc);
  populateLinkTargetSelect();

  el("#documents-list-card").classList.add("hidden");
  el("#document-detail").classList.remove("hidden");
}

const LINK_KIND: Record<string, string> = { invoice: "Rechnung", expense: "Ausgabe", customer: "Kunde" };

function renderDocLinks(doc: DocumentDetail): void {
  el("#document-links").innerHTML =
    doc.links.length === 0
      ? `<span class="muted">Keine Verknüpfungen.</span>`
      : doc.links
          .map(
            (l) =>
              `<span class="link-chip">${LINK_KIND[l.target_type] ?? l.target_type}: ${escapeHtml(l.label) || "#" + l.target_id}
                <button class="link" data-unlink="${l.id}" title="Entfernen">×</button></span>`,
          )
          .join("");
}

function populateLinkTargetSelect(): void {
  const type = el<HTMLSelectElement>("#doc-link-type").value;
  const opts = type === "expense" ? linkTargets.expenses : linkTargets.invoices;
  el<HTMLSelectElement>("#doc-link-target").innerHTML = opts.length
    ? opts.map((o) => `<option value="${o.id}">${escapeHtml(o.label)}</option>`).join("")
    : `<option value="">— keine vorhanden —</option>`;
}

async function addDocumentLink(): Promise<void> {
  if (currentDocId == null) return;
  const type = el<HTMLSelectElement>("#doc-link-type").value as "invoice" | "expense";
  const target = el<HTMLSelectElement>("#doc-link-target").value;
  if (!target) return;
  await api.linkDocument(currentDocId, type, Number(target));
  await openDocumentDetail(currentDocId);
}

async function removeDocumentLink(linkId: number): Promise<void> {
  await api.unlinkDocument(linkId);
  if (currentDocId != null) await openDocumentDetail(currentDocId);
}

function backToDocuments(): void {
  el("#document-detail").classList.add("hidden");
  el("#documents-list-card").classList.remove("hidden");
  void renderDocuments();
}

function readDocumentForm(): {
  title: string;
  document_type_id: number | null;
  customer_id: number | null;
  order_id: number | null;
  doc_date: string | null;
  tags: string[];
} {
  const form = el<HTMLFormElement>("#document-form");
  const v = (name: string): string =>
    (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
  return {
    title: v("title"),
    document_type_id: v("document_type_id") ? Number(v("document_type_id")) : null,
    customer_id: v("customer_id") ? Number(v("customer_id")) : null,
    order_id: v("order_id") ? Number(v("order_id")) : null,
    doc_date: v("doc_date") || null,
    tags: v("tags")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

async function submitDocument(ev: Event): Promise<void> {
  ev.preventDefault();
  if (currentDocId == null) return;
  try {
    await api.updateDocument(currentDocId, readDocumentForm());
    backToDocuments();
  } catch (err) {
    el("#document-error").textContent = msg(err);
  }
}

async function importDocuments(): Promise<void> {
  const res = await api.importDocuments();
  if (res.canceled) return;
  el("#doc-import-msg").textContent =
    `${res.imported} importiert` + (res.duplicates ? `, ${res.duplicates} Dublette(n) übersprungen` : "");
  await renderDocuments();
}

async function deleteCurrentDocument(): Promise<void> {
  if (currentDocId == null) return;
  const ok = await confirmModal({
    title: "Dokument löschen?",
    message:
      "Das Dokument und die verwaltete Datei werden endgültig entfernt (nur möglich, " +
      "solange es nicht als Beleg verknüpft ist – sonst bitte archivieren). " +
      "Die Löschung wird im Journal protokolliert.",
    okLabel: "Löschen",
  });
  if (!ok) return;
  try {
    await api.deleteDocument(currentDocId);
    backToDocuments();
  } catch (err) {
    el("#document-error").textContent = msg(err);
  }
}

// --- Verdrahtung ----------------------------------------------------------

document
  .querySelectorAll<HTMLElement>(".nav-item")
  .forEach((n) => n.addEventListener("click", () => showView(n.dataset.view as ViewName)));

// Kunden
el("#new-customer").addEventListener("click", () => openCustomerForm(null));
el("#customer-search").addEventListener("input", () => {
  window.clearTimeout(customerSearchTimer);
  customerSearchTimer = window.setTimeout(() => void renderCustomers(), 200);
});
el("#cancel-customer").addEventListener("click", () => el("#customer-form").classList.add("hidden"));
el("#customer-form").addEventListener("submit", (ev) => void submitCustomer(ev));
el("#customers").addEventListener("click", async (ev) => {
  const t = ev.target as HTMLElement;
  const open = t.closest<HTMLElement>("[data-open-customer]");
  if (open) {
    void openCustomerDetail(Number(open.dataset.openCustomer));
    return;
  }
  const edit = t.closest<HTMLElement>("[data-edit]");
  if (edit) openCustomerForm(await api.getCustomer(Number(edit.dataset.edit)));
});

el("#back-customers").addEventListener("click", backToCustomers);
el("#customer-invoices").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const open = t.closest<HTMLElement>("[data-cust-open-invoice]");
  if (open) {
    void navigateToInvoice(Number(open.dataset.custOpenInvoice));
    return;
  }
  const pdf = t.closest<HTMLElement>("[data-pdf]");
  if (pdf) void api.openArtifact(Number(pdf.dataset.pdf), "pdf");
});

// Rechnungs-Filter
["#inv-filter-customer", "#inv-filter-from", "#inv-filter-to"].forEach((s) =>
  el(s).addEventListener("change", () => void renderInvoices()),
);
el("#inv-filter-reset").addEventListener("click", () => {
  el<HTMLSelectElement>("#inv-filter-customer").value = "";
  el<HTMLInputElement>("#inv-filter-from").value = "";
  el<HTMLInputElement>("#inv-filter-to").value = "";
  void renderInvoices();
});

// Rechnungen
el("#new-invoice").addEventListener("click", () => void openInvoiceEditor(null));
el("#add-item").addEventListener("click", () => addItemRow());
el("#cancel-invoice").addEventListener("click", closeInvoiceEditor);
el("#save-draft").addEventListener("click", () => void saveDraft());
el("#issue-invoice").addEventListener("click", () => void issueNow());
el("#preview-invoice").addEventListener("click", () => void toggleDraftPreview());
el("#inv-items").addEventListener("input", recomputeTotals);
el("#invoice-discount").addEventListener("input", recomputeTotals);
el("#inv-items").addEventListener("click", (ev) => {
  const remove = (ev.target as HTMLElement).closest(".li-remove");
  if (!remove) return;
  remove.closest("tr")?.remove();
  recomputeTotals();
});
el("#invoices-list").addEventListener("click", async (ev) => {
  const t = ev.target as HTMLElement;
  const open = t.closest<HTMLElement>("[data-open]");
  if (open) {
    void openInvoiceDetail(Number(open.dataset.open));
    return;
  }
  const pdf = t.closest<HTMLElement>("[data-pdf]");
  if (pdf) {
    void api.openArtifact(Number(pdf.dataset.pdf), "pdf");
    return;
  }
  const edit = t.closest<HTMLElement>("[data-edit-draft]");
  if (edit) {
    const det = await api.getInvoice(Number(edit.dataset.editDraft));
    if (det) void openInvoiceEditor(det);
    return;
  }
  const issue = t.closest<HTMLElement>("[data-issue]");
  if (issue) {
    const id = Number(issue.dataset.issue);
    try {
      const res = await api.issueInvoice(id);
      await renderInvoices();
      if (res.pdf_path) await api.openArtifact(id, "pdf");
    } catch (err) {
      await renderInvoices();
      window.alert(msg(err));
    }
  }
});

el("#back-invoices").addEventListener("click", backToInvoiceList);

el("#invoice-detail").addEventListener("click", async (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("#detail-pdf-btn")) {
    if (currentInvoiceId) void api.openArtifact(currentInvoiceId, "pdf");
    return;
  }
  if (t.closest("#detail-validate-btn")) {
    if (currentInvoiceId == null) return;
    el("#invoice-validation").textContent = "Prüfe EN 16931…";
    try {
      const r = await api.validateInvoice(currentInvoiceId);
      el("#invoice-validation").innerHTML = !r.ok
        ? `<span class="error">${escapeHtml(r.error ?? "Prüfung fehlgeschlagen.")}</span>`
        : r.valid
          ? `<span class="ok">✔ EN 16931 gültig (XSD + Schematron)</span>`
          : `<span class="error">✗ Nicht konform:<br />${(r.errors ?? []).map(escapeHtml).join("<br />")}</span>`;
    } catch (err) {
      el("#invoice-validation").innerHTML = `<span class="error">${escapeHtml(msg(err))}</span>`;
    }
    return;
  }
  if (t.closest("#detail-cancel-btn")) {
    if (currentInvoiceId == null) return;
    const reason = await promptModal({
      title: "Rechnung stornieren?",
      message:
        "Die Rechnung bleibt unverändert erhalten und wird durch eine festgeschriebene " +
        "Stornorechnung (Gegenbeleg mit negativen Beträgen) ausgeglichen. " +
        "Dieser Vorgang kann nicht rückgängig gemacht werden.",
      inputCaption: "Grund (optional, erscheint im Journal und auf dem Stornobeleg)",
      okLabel: "Stornieren",
    });
    if (reason === null) return;
    el("#invoice-validation").textContent = "Storno wird erstellt…";
    try {
      const res = await api.cancelInvoice(currentInvoiceId, reason || null);
      await openInvoiceDetail(currentInvoiceId);
      el("#invoice-validation").innerHTML =
        `<span class="ok">✔ Storniert durch ${escapeHtml(res.stornoNumber)}</span>`;
    } catch (err) {
      el("#invoice-validation").innerHTML = `<span class="error">${escapeHtml(msg(err))}</span>`;
    }
    return;
  }
  const openInv = t.closest<HTMLElement>("[data-open-invoice]");
  if (openInv) {
    await openInvoiceDetail(Number(openInv.dataset.openInvoice));
    return;
  }
  const openDoc = t.closest<HTMLElement>("[data-open-linked-doc]");
  if (openDoc) {
    void api.openDocument(Number(openDoc.dataset.openLinkedDoc));
    return;
  }
  const del = t.closest<HTMLElement>("[data-del-payment]");
  if (del && currentInvoiceId) {
    await api.deletePayment(Number(del.dataset.delPayment));
    const d = await api.getInvoice(currentInvoiceId);
    if (d) renderInvoiceDetail(d);
  }
});

el("#payment-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!currentInvoiceId) return;
  const form = el<HTMLFormElement>("#payment-form");
  const value = (n: string): string => (form.elements.namedItem(n) as HTMLInputElement).value;
  try {
    await api.addPayment(currentInvoiceId, value("paid_at"), toCents(value("amount")), value("note") || null);
    const d = await api.getInvoice(currentInvoiceId);
    if (d) renderInvoiceDetail(d);
  } catch (err) {
    el("#payment-error").textContent = msg(err);
  }
});

el("#fill-remaining").addEventListener("click", async () => {
  if (!currentInvoiceId) return;
  const d = await api.getInvoice(currentInvoiceId);
  if (!d) return;
  (el<HTMLFormElement>("#payment-form").elements.namedItem("amount") as HTMLInputElement).value = (
    d.remaining_cents / 100
  ).toFixed(2);
});

// EÜR + Ausgaben
el("#euer-year").addEventListener("change", () => void renderEuerForSelectedYear());
el("#euer-year-add-btn").addEventListener("click", () => void addEuerYear());
el("#euer-year-add").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    void addEuerYear();
  }
});
el("#new-expense").addEventListener("click", () => void openExpenseForm(null));
el("#cancel-expense").addEventListener("click", () => {
  pendingExpenseDocId = null;
  el("#expense-form").classList.add("hidden");
});
el("#expense-form").addEventListener("submit", (ev) => void submitExpense(ev));
el("#expenses-list").addEventListener("click", async (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-edit-expense]");
  if (!target) return;
  void openExpenseForm(await api.getExpense(Number(target.dataset.editExpense)));
});

el("#dash-warnings").addEventListener("click", (ev) => {
  if ((ev.target as HTMLElement).closest("[data-goto-settings]")) showView("settings");
});

// Dashboard – GoBD-Selbstprüfung
interface GobdCheck {
  ok: boolean;
  label: string;
  detail: string;
  note?: string;
}

function buildGobdChecks(r: GobdReport): GobdCheck[] {
  const chain = r.auditChain;
  const inv = r.invoices;
  const art = r.artifacts;
  const trg = r.triggers;
  const side = r.sideRecords;
  const docs = r.documents;
  return [
    {
      ok: chain.ok,
      label: "Journal-Hash-Kette",
      detail: chain.ok
        ? chain.entries === 0
          ? "Noch keine Journaleinträge vorhanden."
          : `${chain.entries} Einträge lückenlos verkettet (${fmtDateTime(chain.firstAt)} – ${fmtDateTime(chain.lastAt)}).`
        : `Kette gebrochen bei Journaleintrag #${chain.brokenAtId} – das Journal wurde nachträglich verändert.`,
      note:
        chain.nonMonotonic > 0
          ? `${chain.nonMonotonic} Eintrag/Einträge mit rückläufigem Zeitstempel – mögliche Verstellung der Systemuhr.`
          : undefined,
    },
    {
      ok: inv.tampered.length === 0,
      label: "Beleg-Prüfsummen",
      detail:
        inv.issued === 0
          ? "Keine festgeschriebenen Rechnungen."
          : inv.tampered.length === 0
            ? `${inv.hashOk}/${inv.issued} festgeschriebene Rechnungen unverändert (Prüfsumme neu berechnet).`
            : `${inv.tampered.length} Rechnung(en) mit abweichender Prüfsumme: ${inv.tampered
                .map((t) => escapeHtml(t.invoiceNumber))
                .join(", ")} – die eingefrorenen Daten wurden manipuliert.`,
    },
    {
      ok: art.missingFiles.length === 0 && art.hashMismatch.length === 0,
      label: "Rechnungsdateien",
      detail:
        art.hashMismatch.length > 0
          ? `${art.hashMismatch.length} Datei(en) mit abweichender Prüfsumme: ${art.hashMismatch
              .map((m) => `${escapeHtml(m.invoiceNumber)} (${m.kind.toUpperCase()})`)
              .join(", ")} – der Dateiinhalt wurde nachträglich verändert.`
          : art.missingFiles.length > 0
            ? `${art.missingFiles.length} hinterlegte Datei(en) fehlen: ${art.missingFiles
                .map((m) => `${escapeHtml(m.invoiceNumber)} (${m.kind.toUpperCase()})`)
                .join(", ")} – möglicher Datenverlust.`
            : `${art.pdfOk}/${art.expectedPdf} PDF/A-Dateien vorhanden, ${art.hashChecked} Prüfsumme(n) byte-genau bestätigt.`,
      note:
        art.withoutPdf.length > 0
          ? `${art.withoutPdf.length} festgeschriebene Rechnung(en) ohne hinterlegtes PDF (neu erzeugbar).`
          : undefined,
    },
    {
      ok: trg.ok,
      label: "Schreibschutz-Trigger",
      detail: trg.ok
        ? `${trg.present}/${trg.expected} Sperr-Trigger aktiv (festgeschriebene Rechnungen & Journal sind unveränderbar).`
        : `${trg.missing.length} Trigger fehlen: ${trg.missing.join(", ")} – der Datenbank-Schreibschutz ist unvollständig.`,
    },
    {
      ok: side.mismatches.length === 0,
      label: "Zahlungen & Ausgaben",
      detail:
        side.mismatches.length === 0
          ? `${side.paymentsOk}/${side.payments} Zahlungen und ${side.expensesOk}/${side.expenses} Ausgaben stimmen mit den Journal-Snapshots überein.`
          : `${side.mismatches.length} Abweichung(en) vom Journal: ${side.mismatches
              .map((m) => `${m.kind === "payment" ? "Zahlung" : "Ausgabe"} #${m.id} (${m.problem})`)
              .join(", ")} – mögliche Änderung an der Anwendung vorbei.`,
    },
    {
      ok: docs.missing.length === 0 && docs.mismatch.length === 0,
      label: "Dokumente (DMS)",
      detail:
        docs.total === 0
          ? "Keine Dokumente abgelegt."
          : docs.missing.length === 0 && docs.mismatch.length === 0
            ? `${docs.ok}/${docs.total} Dokumente byte-genau bestätigt (SHA-256).`
            : [
                docs.missing.length > 0
                  ? `${docs.missing.length} Datei(en) fehlen: ${docs.missing.map((d) => escapeHtml(d.title)).join(", ")}`
                  : "",
                docs.mismatch.length > 0
                  ? `${docs.mismatch.length} Datei(en) verändert: ${docs.mismatch.map((d) => escapeHtml(d.title)).join(", ")}`
                  : "",
              ]
                .filter(Boolean)
                .join(" · "),
    },
    {
      ok: true, // Zeitgerechtheit ist ein Hinweis, kein Integritätsfehler
      label: "Zeitgerechtheit",
      detail:
        r.timeliness.openDrafts === 0
          ? "Keine offenen Rechnungsentwürfe."
          : `${r.timeliness.openDrafts} offene(r) Entwurf/Entwürfe` +
            (r.timeliness.oldestDraftDays != null
              ? `, ältester ${r.timeliness.oldestDraftDays} Tag(e)`
              : "") +
            ".",
      note:
        r.timeliness.staleDrafts > 0
          ? `${r.timeliness.staleDrafts} Entwurf/Entwürfe älter als 30 Tage – zeitgerechte Festschreibung prüfen (GoBD Rz. 45 ff.).`
          : undefined,
    },
  ];
}

function renderGobdReport(r: GobdReport): string {
  const rows = buildGobdChecks(r)
    .map(
      (c) => `<li class="gobd-check ${c.ok ? "ok" : "err"}">
        <span class="gobd-dot" aria-hidden="true">${c.ok ? "✔" : "✗"}</span>
        <span class="gobd-check-body">
          <strong>${c.label}</strong>
          <small>${c.detail}</small>
          ${c.note ? `<small class="gobd-note">Hinweis: ${c.note}</small>` : ""}
        </span>
      </li>`,
    )
    .join("");
  const head = r.ok
    ? "✔ GoBD-Selbstprüfung bestanden"
    : "✗ GoBD-Selbstprüfung: Probleme gefunden";
  return `<div class="result ${r.ok ? "result-ok" : "result-err"}">
      <div class="gobd-report-head">
        <strong>${head}</strong>
        <small>geprüft am ${fmtDateTime(r.checkedAt)}</small>
      </div>
      <ul class="gobd-checks">${rows}</ul>
    </div>`;
}

el("#verify").addEventListener("click", async () => {
  el("#results").innerHTML = `<div class="result">GoBD-Prüfung läuft …</div>`;
  try {
    el("#results").innerHTML = renderGobdReport(await api.gobdReport());
  } catch (err) {
    el("#results").innerHTML = `<div class="result result-err">Prüfung fehlgeschlagen: ${escapeHtml(msg(err))}</div>`;
  }
});

// Journal / Nachweis
const ENTITY_LABEL: Record<string, string> = {
  invoice: "Rechnung",
  payment: "Zahlung",
  expense: "Ausgabe",
  document: "Dokument",
};

function journalChainCell(e: JournalEntry): string {
  return `<span class="journal-chain ${e.chainOk ? "ok" : "err"}"><span class="mono">${escapeHtml(
    e.recordHash.slice(0, 10),
  )}…</span> ${e.chainOk ? "✓" : "✗"}</span>`;
}

async function renderJournal(): Promise<void> {
  const type = el<HTMLSelectElement>("#journal-filter-type").value;
  const all = await api.listJournal();
  const entries =
    type === "system"
      ? all.filter((e) => e.entityType === "backup" || e.entityType === "verfdok")
      : type
        ? all.filter((e) => e.entityType === type)
        : all;
  const broken = all.filter((e) => !e.chainOk).length;
  el("#journal-status").textContent =
    all.length === 0
      ? "Noch keine Journaleinträge."
      : `${all.length} Einträge · ${broken === 0 ? "Kette lückenlos ✓" : `⚠ ${broken} Bruch/Brüche`}`;
  el("#journal-list").innerHTML = entries.length
    ? entries
        .map(
          (e) => `<tr>
            <td>${e.id}</td>
            <td>${escapeHtml(fmtDateTime(e.at))}</td>
            <td><span class="badge badge-tag">${escapeHtml(ENTITY_LABEL[e.entityType] ?? e.entityType)}</span> ${escapeHtml(e.summary)}</td>
            <td>${e.reference ? escapeHtml(e.reference) : "—"}</td>
            <td>${journalChainCell(e)}</td>
          </tr>`,
        )
        .join("")
    : `<tr>
        <td colspan="5" class="table-empty-state">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon"><path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 4-4"/><circle cx="7" cy="14" r="0.5"/></svg>
          <div class="title">Keine Journaleinträge gefunden</div>
          <div class="desc">Für den ausgewählten Filter sind keine Protokolleinträge vorhanden.</div>
        </td>
       </tr>`;
}

async function renderInvoiceJournal(id: number): Promise<void> {
  const entries = await api.listJournalForInvoice(id);
  el("#invoice-journal").innerHTML = entries.length
    ? `<ul class="journal-mini">${entries
        .map(
          (e) =>
            `<li><span class="muted">${escapeHtml(fmtDateTime(e.at))}</span> — ${escapeHtml(
              e.summary,
            )} ${journalChainCell(e)}</li>`,
        )
        .join("")}</ul>`
    : `<span class="muted">Keine Journaleinträge.</span>`;
}

el("#journal-filter-type").addEventListener("change", () => void renderJournal());
el("#journal-export").addEventListener("click", async () => {
  el("#journal-msg").textContent = "Export läuft …";
  try {
    const res = await api.exportJournal();
    el("#journal-msg").textContent = res.ok
      ? `✔ ${res.count} Einträge exportiert: ${res.path}`
      : res.canceled
        ? "Abgebrochen."
        : "Export fehlgeschlagen.";
  } catch (err) {
    el("#journal-msg").textContent = msg(err);
  }
});

// Firma bearbeiten
el("#edit-company").addEventListener("click", () => void openCompanyForm());
el("#cancel-company").addEventListener("click", () => el("#company-form").classList.add("hidden"));
el("#company-form").addEventListener("submit", (ev) => void submitCompany(ev));

// Daten & Sicherung
el("#open-datadir").addEventListener("click", () => void api.openDataDir());
el("#change-datadir").addEventListener("click", async () => {
  const ok = await confirmModal({
    title: "Speicherort wechseln?",
    message:
      "Die Daten werden in den gewählten Ordner kopiert und die App startet neu. " +
      "Die bisherigen Dateien bleiben als Sicherung erhalten.",
    okLabel: "Ordner wählen…",
  });
  if (!ok) return;
  try {
    const res = await api.changeDataDir();
    if (!res.moved) el("#storage-msg").textContent = "Abgebrochen.";
    // Bei Erfolg startet die App neu; hier ist dann nichts mehr zu tun.
  } catch (err) {
    el("#storage-msg").textContent = msg(err);
  }
});
// Verfahrensdokumentation: organisatorische Angaben im Formular erfassen –
// sie werden gespeichert und beim Export direkt in das Dokument eingesetzt.
function verfdokTextsFromForm(): Record<string, string> {
  const texts: Record<string, string> = {};
  el("#verfdok-fields")
    .querySelectorAll<HTMLTextAreaElement>("textarea[data-key]")
    .forEach((area) => {
      texts[area.dataset.key ?? ""] = area.value;
    });
  return texts;
}

async function exportVerfdok(format: "pdf" | "md"): Promise<void> {
  el("#verfdok-msg").textContent = "Dokument wird erstellt…";
  try {
    const res = await api.exportVerfahrensdok(format, verfdokTextsFromForm());
    if (res.ok) el("#verfdok-overlay").classList.add("hidden");
    el("#verfdok-msg").textContent = res.ok
      ? `✔ Exportiert: ${res.path} – bitte prüfen, ausdrucken und unterschreiben.`
      : res.canceled
        ? "Abgebrochen."
        : "Export fehlgeschlagen.";
  } catch (err) {
    el("#verfdok-msg").textContent = msg(err);
  }
}

el("#export-verfdok").addEventListener("click", async () => {
  el("#verfdok-msg").textContent = "";
  try {
    const texts = await api.getVerfdokTexts();
    const wrap = el("#verfdok-fields");
    wrap.innerHTML = "";
    for (const field of VERFDOK_FIELDS) {
      const label = document.createElement("label");
      const caption = document.createElement("span");
      caption.textContent = field.label;
      const area = document.createElement("textarea");
      area.rows = 3;
      area.dataset.key = field.key;
      area.placeholder = field.hint;
      area.value = texts[field.key] ?? "";
      label.append(caption, area);
      wrap.append(label);
    }
    el("#verfdok-overlay").classList.remove("hidden");
  } catch (err) {
    el("#verfdok-msg").textContent = msg(err);
  }
});
el("#verfdok-cancel").addEventListener("click", () => {
  el("#verfdok-overlay").classList.add("hidden");
});
el("#verfdok-export-pdf").addEventListener("click", () => void exportVerfdok("pdf"));
el("#verfdok-export-md").addEventListener("click", () => void exportVerfdok("md"));
el("#export-z3").addEventListener("click", async () => {
  el("#z3-msg").textContent = "Datenexport wird erstellt…";
  try {
    const res = await api.exportZ3();
    el("#z3-msg").textContent = res.ok
      ? `✔ ${res.files} Dateien exportiert: ${res.path}`
      : res.canceled
        ? "Abgebrochen."
        : "Export fehlgeschlagen.";
  } catch (err) {
    el("#z3-msg").textContent = msg(err);
  }
});
el("#create-backup").addEventListener("click", async () => {
  el("#storage-msg").textContent = "Sicherung wird erstellt…";
  try {
    const res = await api.createBackup();
    if (!res.ok) {
      el("#storage-msg").textContent = res.canceled ? "Abgebrochen." : "Sicherung fehlgeschlagen.";
      return;
    }
    el("#storage-msg").textContent =
      `✔ Sicherung erstellt: ${res.path} · Audit-Kette ${res.auditOk ? "intakt" : "GEBROCHEN"}`;
  } catch (err) {
    el("#storage-msg").textContent = msg(err);
  }
});

// Über GoBDesk
el("#about-repo").addEventListener("click", () => void api.openExternal(aboutRepoUrl));
el("#about-licenses").addEventListener("click", () =>
  void api.openExternal(`${aboutRepoUrl}/blob/main/THIRD-PARTY-LICENSES.md`),
);
el("#check-update").addEventListener("click", () => void runUpdateCheck(true));
const openReleaseFromButton = (ev: Event): void => {
  const url = (ev.currentTarget as HTMLElement).dataset.url;
  if (url) void api.openExternal(url);
};
el("#update-available").addEventListener("click", openReleaseFromButton);
el("#titlebar-update").addEventListener("click", openReleaseFromButton);

// Dokumente
el("#import-doc").addEventListener("click", () => void importDocuments());
el("#doc-search").addEventListener("input", () => {
  window.clearTimeout(docSearchTimer);
  docSearchTimer = window.setTimeout(() => void renderDocuments(), 200);
});
["#doc-filter-type", "#doc-filter-customer", "#doc-filter-order", "#doc-filter-archived"].forEach(
  (sel) => el(sel).addEventListener("change", () => void renderDocuments()),
);
el("#doc-filter-reset").addEventListener("click", () => {
  el<HTMLInputElement>("#doc-search").value = "";
  el<HTMLSelectElement>("#doc-filter-type").value = "";
  el<HTMLSelectElement>("#doc-filter-customer").value = "";
  el<HTMLSelectElement>("#doc-filter-order").value = "";
  el<HTMLInputElement>("#doc-filter-archived").checked = false;
  void renderDocuments();
});
el("#documents-list").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const detail = t.closest<HTMLElement>("[data-doc-detail]");
  if (detail) {
    void openDocumentDetail(Number(detail.dataset.docDetail));
    return;
  }
  const open = t.closest<HTMLElement>("[data-doc-open]");
  if (open) void api.openDocument(Number(open.dataset.docOpen));
});
el("#back-documents").addEventListener("click", backToDocuments);
el("#document-form").addEventListener("submit", (ev) => void submitDocument(ev));
el("#open-doc").addEventListener("click", () => {
  if (currentDocId != null) void api.openDocument(currentDocId);
});
el("#delete-doc").addEventListener("click", () => void deleteCurrentDocument());
el("#archive-doc").addEventListener("click", async () => {
  if (currentDocId == null) return;
  const doc = await api.getDocument(currentDocId);
  if (!doc) return;
  try {
    await api.archiveDocument(currentDocId, doc.is_archived !== 1);
    await openDocumentDetail(currentDocId);
  } catch (err) {
    el("#document-error").textContent = msg(err);
  }
});
el("#save-ocr").addEventListener("click", async () => {
  if (currentDocId == null) return;
  try {
    await api.updateDocumentOcr(currentDocId, el<HTMLTextAreaElement>("#doc-ocr-text").value);
    el("#doc-ocr-msg").textContent = "✔ Gespeichert (Korrektur journalisiert).";
  } catch (err) {
    el("#doc-ocr-msg").textContent = msg(err);
  }
});
el("#document-einvoice").addEventListener("click", async (ev) => {
  if (!(ev.target as HTMLElement).closest("#einvoice-to-expense") || currentDocId == null) return;
  const doc = await api.getDocument(currentDocId);
  const inv = doc?.einvoice;
  if (!doc || !inv) return;
  pendingExpenseDocId = doc.id;
  showView("euer");
  await openExpenseForm({
    expense_date: inv.issue_date ?? today(),
    payment_date: null,
    description: inv.number ? `Rechnung ${inv.number}` : doc.title,
    vendor: inv.seller,
    gross_cents: inv.gross_cents ?? 0,
    tax_rate_bp: inv.tax_rate_bp ?? undefined,
  });
});
el("#doc-link-type").addEventListener("change", populateLinkTargetSelect);
el("#doc-link-add").addEventListener("click", () => void addDocumentLink());
el("#document-links").addEventListener("click", (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-unlink]");
  if (t) void removeDocumentLink(Number(t.dataset.unlink));
});

// „öffnen" bei verknüpften Dokumenten in den Rückansichten (Kunde/Ausgabe)
function wireLinkedDocOpen(container: string): void {
  el(container).addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-open-linked-doc]");
    if (t) void api.openDocument(Number(t.dataset.openLinkedDoc));
  });
}
wireLinkedDocOpen("#customer-documents");
wireLinkedDocOpen("#expense-documents");

// Drag & Drop: Dateien ins Fenster ziehen -> in die Dokumente-Ablage importieren
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
const dropCard = el("#documents-list-card");
dropCard.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropCard.classList.add("drag-over");
});
dropCard.addEventListener("dragleave", (e) => {
  if (e.target === dropCard) dropCard.classList.remove("drag-over");
});
dropCard.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropCard.classList.remove("drag-over");
  const paths = Array.from(e.dataTransfer?.files ?? [])
    .map((f) => api.getPathForFile(f))
    .filter(Boolean);
  if (paths.length === 0) return;
  el("#doc-import-msg").textContent = "Import läuft…";
  const res = await api.importDocumentPaths(paths);
  el("#doc-import-msg").textContent =
    `${res.imported} importiert` + (res.duplicates ? `, ${res.duplicates} Dublette(n)` : "");
  await renderDocuments();
});

// Aufträge
el("#new-order").addEventListener("click", () => void openOrderForm(null));
el("#order-search").addEventListener("input", () => {
  window.clearTimeout(orderSearchTimer);
  orderSearchTimer = window.setTimeout(() => void renderOrders(), 200);
});
el("#order-status-filter").addEventListener("change", () => void renderOrders());
el("#cancel-order").addEventListener("click", () => el("#order-form").classList.add("hidden"));
el("#order-form").addEventListener("submit", (ev) => void submitOrder(ev));
el("#orders-list").addEventListener("click", (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-order-detail]");
  if (t) void openOrderDetail(Number(t.dataset.orderDetail));
});
el("#back-orders").addEventListener("click", backToOrders);
el("#order-edit").addEventListener("click", () => {
  if (currentOrder) void openOrderForm(currentOrder);
});
el("#order-add-invoice").addEventListener("click", () => void addInvoiceForOrder());
el("#order-import-doc").addEventListener("click", () => void importDocForOrder());
el("#order-delete").addEventListener("click", () => void deleteCurrentOrder());
el("#order-invoices").addEventListener("click", (ev) => {
  const inv = (ev.target as HTMLElement).closest<HTMLElement>("[data-order-open-invoice]");
  if (inv) {
    showView("invoices");
    void openInvoiceDetail(Number(inv.dataset.orderOpenInvoice));
  }
});
el("#order-documents").addEventListener("click", (ev) => {
  const d = (ev.target as HTMLElement).closest<HTMLElement>("[data-order-open-doc]");
  if (d) void api.openDocument(Number(d.dataset.orderOpenDoc));
});

showView("dashboard");
void runUpdateCheck(false); // Titelleisten-Hinweis, still bei offline/Fehler
