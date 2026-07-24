/** Geteilte Typen der IPC-Brücke – von Preload (Node) und Renderer (Browser) genutzt. */

export interface CompanySettings {
  id: number;
  legal_name: string;
  address_line1: string;
  zip: string;
  city: string;
  country_iso: string;
  tax_number: string | null;
  vat_id: string | null;
  is_kleinunternehmer: number;
  email: string | null;
  iban: string | null;
  bic: string | null;
  paypal: string | null;
}

export type CompanySettingsInput = Omit<CompanySettings, "id">;

export interface Customer {
  id: number;
  customer_number: string | null;
  company_name: string | null;
  city: string | null;
  is_active: number;
}

export interface CustomerListItem {
  id: number;
  customer_number: string | null;
  name: string;
  city: string | null;
  email: string | null;
  vat_id: string | null;
  invoice_count: number;
  gross_total_cents: number;
  open_cents: number;
}

export interface DemoInvoiceResult {
  invoiceNumber: string;
  contentHash: string;
  net_total_cents: number;
  tax_total_cents: number;
  gross_total_cents: number;
}

/** Ergebnis der GoBD-Selbstprüfung (Journal-Hash-Kette, Belegprüfsummen, Dateien, Trigger). */
export interface GobdReport {
  ok: boolean;
  checkedAt: string;
  auditChain: {
    ok: boolean;
    entries: number;
    brokenAtId: number | null;
    firstAt: string | null;
    lastAt: string | null;
    /** Einträge, deren Zeitstempel deutlich vor dem Vorgänger liegt (Uhr zurückgestellt?). */
    nonMonotonic: number;
  };
  invoices: {
    issued: number;
    hashOk: number;
    tampered: { id: number; invoiceNumber: string }[];
  };
  artifacts: {
    expectedPdf: number;
    pdfOk: number;
    /** Anzahl Dateien, deren gespeicherte SHA-256-Prüfsumme neu bestätigt wurde. */
    hashChecked: number;
    /** Artefakt in der DB verzeichnet, Datei aber nicht auffindbar → Datenverlust (Fehler). */
    missingFiles: { invoiceNumber: string; kind: "pdf" | "xml"; path: string }[];
    /** Datei vorhanden, aber SHA-256 weicht vom Soll ab → Manipulation (Fehler). */
    hashMismatch: { invoiceNumber: string; kind: "pdf" | "xml"; path: string }[];
    /** Festgeschriebene Rechnung ohne hinterlegtes PDF → Hinweis (z. B. neu zu erzeugen). */
    withoutPdf: { invoiceNumber: string }[];
  };
  triggers: {
    ok: boolean;
    present: number;
    expected: number;
    missing: string[];
  };
  /** Zahlungen & Ausgaben gegen die (manipulationssicheren) Journal-Snapshots abgeglichen. */
  sideRecords: {
    payments: number;
    paymentsOk: number;
    expenses: number;
    expensesOk: number;
    otherIncome: number;
    otherIncomeOk: number;
    mismatches: { kind: "payment" | "expense" | "income"; id: number; problem: string }[];
  };
  /** DMS-Dokumente byte-genau gegen die beim Import gespeicherte Prüfsumme geprüft. */
  documents: {
    total: number;
    ok: number;
    missing: { id: number; title: string }[];
    mismatch: { id: number; title: string }[];
  };
  /** Zeitgerechtheit (GoBD Rz. 45 ff.): alte, nicht festgeschriebene Entwürfe (Hinweis). */
  timeliness: {
    openDrafts: number;
    staleDrafts: number;
    oldestDraftDays: number | null;
  };
}

/** Ein menschenlesbarer Eintrag des revisionssicheren Journals (audit_log). */
export interface JournalEntry {
  id: number;
  at: string;
  entityType: string;
  entityId: number;
  action: string;
  reference: string | null; // Beleg (z. B. Rechnungsnummer)
  summary: string; // was passiert ist (in Worten)
  relatedInvoiceId: number | null; // für die Beleg-Historie
  recordHash: string;
  chainOk: boolean; // Verkettung an dieser Stelle intakt?
}

/** Schneller Integritäts-Check beim App-Start (nur DB, keine Datei-Hashes). */
export interface GobdQuickCheck {
  ok: boolean;
  chainOk: boolean;
  brokenAtId: number | null;
  nonMonotonic: number;
  tampered: number;
}

export interface JournalExportResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  count?: number;
}

export interface CustomerInput {
  kind: "company" | "individual";
  company_name: string | null;
  contact_last_name: string | null;
  street: string | null;
  zip: string | null;
  city: string | null;
  country_iso: string;
  email: string | null;
  vat_id: string | null;
}

export interface CustomerDetail extends CustomerInput {
  id: number;
  customer_number: string | null;
  is_active: number;
}

export interface TaxRate {
  id: number;
  name: string;
  rate_bp: number;
  is_default: number;
}

export interface InvoiceListItem {
  id: number;
  invoice_number: string | null;
  status: string;
  issue_date: string | null;
  customer_name: string | null;
  gross_total_cents: number | null;
  cancels_invoice_id: number | null;
  has_pdf: number;
  is_paid: number;
  paid_cents: number;
}

export interface InvoiceFilter {
  customerId?: number | null;
  from?: string | null;
  to?: string | null;
  orderId?: number | null;
}

/** Eine geplante Rate eines Soll-Zahlungsplans (Ratenplan). Reine Vereinbarung –
 *  kein Zufluss; die tatsächlichen Eingänge stehen in `payments` (EÜR). */
export interface InstallmentInput {
  due_date: string;
  amount_cents: number;
}

export interface Installment extends InstallmentInput {
  seq: number;
}

/** Erfassungsart eines Zu-/Abschlags: prozentual (Wert in bp) oder absolut (Cent). */
export type AdjustmentType = "percent" | "amount";

/** Ein Zu- oder Abschlag (Rabatt/Aufpreis) auf Positions- oder Rechnungsebene. */
export interface LineAdjustment {
  type: AdjustmentType;
  /** percent → Basispunkte (3000 = 30 %); amount → Cent. */
  value: number;
  reason?: string | null;
}

export interface InvoiceItemDetail {
  position: number;
  description: string;
  quantity_milli: number;
  unit: string;
  unit_price_net_cents: number;
  tax_rate_bp: number;
  /** Positions-Rabatt (EN 16931 BG-27). */
  discount: LineAdjustment | null;
  /** Positions-Aufpreis (EN 16931 BG-28). */
  surcharge: LineAdjustment | null;
  line_net_cents: number | null;
  line_gross_cents: number | null;
}

export interface PaymentItem {
  id: number;
  paid_at: string;
  amount_cents: number;
  method: string | null;
  note: string | null;
}

export interface InvoiceDetail {
  id: number;
  invoice_number: string | null;
  status: string;
  issue_date: string | null;
  service_date: string | null;
  customer_name: string | null;
  customer_id: number;
  order_id: number | null;
  order_number: string | null;
  /** Gesetzt am stornierten Original: die Stornorechnung. */
  cancelled_by_invoice_id: number | null;
  cancelled_by_number: string | null;
  /** Gesetzt an der Stornorechnung: das stornierte Original. */
  cancels_invoice_id: number | null;
  cancels_number: string | null;
  notes: string | null;
  /** Rechnungsweiter Rabatt (EN 16931 BG-20). */
  discount: LineAdjustment | null;
  net_total_cents: number | null;
  tax_total_cents: number | null;
  gross_total_cents: number | null;
  has_pdf: number;
  items: InvoiceItemDetail[];
  /** Soll-Zahlungsplan (Ratenplan), leer wenn keiner vereinbart. */
  installments: Installment[];
  payments: PaymentItem[];
  paid_cents: number;
  remaining_cents: number;
  payment_status: "offen" | "teilweise" | "bezahlt";
}

export interface InvoiceLineInput {
  description: string;
  quantity_milli: number;
  unit: string;
  unit_price_net_cents: number;
  tax_rate_bp: number;
  /** Positions-Rabatt (EN 16931 BG-27). */
  discount?: LineAdjustment | null;
  /** Positions-Aufpreis (EN 16931 BG-28). */
  surcharge?: LineAdjustment | null;
}

export interface DraftInvoiceInput {
  customer_id: number;
  issue_date: string;
  service_date: string;
  payment_terms: string | null;
  order_id?: number | null;
  /** Rechnungsweiter Rabatt (EN 16931 BG-20). */
  discount?: LineAdjustment | null;
  /** Optionaler Soll-Zahlungsplan (Ratenplan). */
  installments?: InstallmentInput[];
  lines: InvoiceLineInput[];
}

export interface IssueInvoiceResult {
  invoiceNumber: string;
  contentHash: string;
  net_total_cents: number;
  tax_total_cents: number;
  gross_total_cents: number;
  pdf_path: string | null;
  xml_path: string | null;
}

export interface CancelInvoiceResult {
  stornoId: number;
  stornoNumber: string;
  originalNumber: string;
  pdf_path: string | null;
}

/** Eine überfällige, noch offene Rechnung (Mahnwesen). */
export interface OverdueInvoice {
  id: number;
  invoice_number: string | null;
  customer_name: string | null;
  /** Fälligkeit der ältesten offenen, bereits fälligen Rate bzw. das Zahlungsziel. */
  due_date: string;
  days_overdue: number;
  gross_cents: number;
  paid_cents: number;
  /** Offener Gesamtbetrag der Rechnung. */
  open_cents: number;
  /** Davon bereits fällig – bei Ratenplan nur die fälligen Raten. */
  due_now_cents: number;
  /** Anzahl Raten des Soll-Zahlungsplans (0 = kein Ratenplan). */
  installment_count: number;
  /** Höchste bereits erzeugte Mahnstufe (0 = noch keine). */
  last_level: number;
  /** Vorschlag für die nächste Stufe (1 = Erinnerung … 3 = 2. Mahnung). */
  next_level: number;
}

export interface DunningResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  /** Id des automatisch im DMS abgelegten und verknüpften Dokuments. */
  documentId?: number;
}

export interface EuerCategory {
  id: number;
  code: string;
  name: string;
  kind: string;
}

export interface ExpenseInput {
  expense_date: string;
  payment_date: string | null;
  description: string;
  vendor: string | null;
  category_id: number;
  gross_cents: number;
  tax_rate_bp: number;
  deductible_permille: number;
  order_id?: number | null;
}

export interface ExpenseDetail extends ExpenseInput {
  id: number;
}

export interface ExpenseListItem {
  id: number;
  expense_date: string;
  description: string;
  vendor: string | null;
  category_name: string | null;
  net_cents: number;
  gross_cents: number;
  deductible_permille: number;
}

/**
 * Sonstige Betriebseinnahme außerhalb einer Rechnung – typischer Fall:
 * **Mahngebühr/Verzugszinsen**. Diese sind Betriebseinnahmen bei Zufluss, aber
 * **ohne USt** (echter Schadensersatz), deshalb `tax_rate_bp` in der Regel 0.
 */
export interface OtherIncomeInput {
  income_date: string;
  description: string;
  category_id: number;
  gross_cents: number;
  tax_rate_bp: number;
  /** Optionaler Bezug zur Rechnung (z. B. der gemahnten). */
  invoice_id?: number | null;
  note?: string | null;
}

export interface OtherIncomeDetail extends OtherIncomeInput {
  id: number;
}

export interface OtherIncomeListItem {
  id: number;
  income_date: string;
  description: string;
  category_name: string | null;
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  invoice_number: string | null;
}

export interface EuerReport {
  year: number;
  is_kleinunternehmer: boolean;
  income_net_cents: number;
  ust_collected_cents: number;
  expenses: { category: string; amount_cents: number }[];
  expenses_total_cents: number;
  vorsteuer_cents: number;
  profit_cents: number;
  ust_zahllast_cents: number;
}

export interface DocumentType {
  id: number;
  name: string;
}

export interface Tag {
  id: number;
  name: string;
  color: string | null;
}

export interface DocumentListItem {
  id: number;
  title: string;
  doc_date: string | null;
  original_filename: string | null;
  file_size: number | null;
  added_at: string;
  type_name: string | null;
  customer_name: string | null;
  tags: string | null;
  is_archived: number;
}

export type DocumentTargetType = "customer" | "invoice" | "expense";

export interface DocumentLink {
  id: number;
  target_type: DocumentTargetType;
  target_id: number;
  label: string | null;
}

export interface LinkTargetOption {
  id: number;
  label: string;
}

export interface LinkTargets {
  invoices: LinkTargetOption[];
  expenses: LinkTargetOption[];
}

export interface DocumentDetail {
  id: number;
  title: string;
  original_filename: string | null;
  mime_type: string | null;
  file_size: number | null;
  document_type_id: number | null;
  customer_id: number | null;
  doc_date: string | null;
  added_at: string;
  type_name: string | null;
  customer_name: string | null;
  order_id: number | null;
  order_number: string | null;
  is_archived: number;
  ocr_text: string | null;
  einvoice: EInvoiceData | null;
  tags: string[];
  links: DocumentLink[];
}

/** Kerndaten einer empfangenen E-Rechnung (ZUGFeRD/Factur-X/XRechnung). */
export interface EInvoiceData {
  syntax: "CII" | "UBL";
  number: string | null;
  issue_date: string | null;
  seller: string | null;
  gross_cents: number | null;
  tax_cents: number | null;
  tax_rate_bp: number | null;
  currency: string | null;
}

export interface DocumentImportResult {
  id: number;
  duplicate: boolean;
}

export interface DocumentImportSummary {
  imported: number;
  duplicates: number;
  canceled?: boolean;
}

export interface DocumentUpdateInput {
  title: string;
  document_type_id: number | null;
  customer_id: number | null;
  order_id?: number | null;
  doc_date: string | null;
  tags: string[];
}

export interface DocumentFilter {
  search?: string | null;
  typeId?: number | null;
  customerId?: number | null;
  orderId?: number | null;
  /** true = auch archivierte Dokumente anzeigen (Standard: nur aktive). */
  includeArchived?: boolean;
}

/** Vom Anwender auszufüllende organisatorische Angaben der Verfahrensdokumentation. */
export interface VerfdokField {
  key: string;
  label: string;
  hint: string;
}

export const VERFDOK_FIELDS: readonly VerfdokField[] = [
  {
    key: "business",
    label: "Geschäftstätigkeit & Abläufe",
    hint:
      "Kurzbeschreibung der Geschäftstätigkeit und der betrieblichen Abläufe " +
      "(z. B. angebotene Leistungen, typischer Ablauf von Auftrag bis Rechnung).",
  },
  {
    key: "erfassung",
    label: "Belegerfassung & Posteingang",
    hint:
      "Organisatorische Regelungen: Wer erfasst wann Belege? Posteingangsprozess für " +
      "Papierbelege (wer scannt, wann, Qualitätskontrolle, Umgang mit den Papier-Originalen).",
  },
  {
    key: "sicherheit",
    label: "Zugriffsschutz & Datensicherung",
    hint:
      "Windows-Konto/Passwort, Festplattenverschlüsselung (z. B. BitLocker), Aufbewahrungsorte " +
      "der Sicherungen (3-2-1-Regel: 3 Kopien, 2 Medien, 1 extern), letzter Wiederherstellungstest.",
  },
] as const;

export type VerfdokFormat = "pdf" | "md";

export interface Z3ExportResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  files?: number;
}

export interface ValidationResult {
  ok: boolean;
  valid?: boolean;
  xml_found?: boolean;
  errors?: string[];
  error?: string;
}

export interface StorageInfo {
  dataDir: string;
  defaultDir: string;
  isCustom: boolean;
  dbPath: string;
  lastBackupAt: string | null;
}

export interface BackupResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  auditOk?: boolean;
  sizeBytes?: number;
}

export interface ChangeDataDirResult {
  moved: boolean;
  dir?: string;
}

export type OrderStatus = "offen" | "in_arbeit" | "abgeschlossen" | "storniert";

export interface OrderInput {
  order_number: string | null; // null => automatisch vergeben
  customer_id: number | null;
  title: string;
  status: OrderStatus;
  order_date: string | null;
  notes: string | null;
}

export interface OrderFilter {
  search?: string | null;
  status?: OrderStatus | null;
}

export interface OrderListItem {
  id: number;
  order_number: string;
  title: string;
  status: OrderStatus;
  order_date: string | null;
  customer_name: string | null;
  invoice_count: number;
  document_count: number;
  expense_count: number;
}

export interface OrderDetail {
  id: number;
  order_number: string;
  customer_id: number | null;
  customer_name: string | null;
  title: string;
  status: OrderStatus;
  order_date: string | null;
  notes: string | null;
  invoices: InvoiceListItem[];
  documents: DocumentListItem[];
  expenses: ExpenseListItem[];
}

export interface OrderOption {
  id: number;
  label: string;
}

/** Herkunfts- und Lizenzangaben der App (für die „Über"-Karte). */
export interface AppInfo {
  name: string;
  version: string;
  author: string;
  license: string;
  repository: string;
  copyrightYear: number;
}

/** Ergebnis der Update-Prüfung gegen die neueste GitHub-Release-Version. */
export interface UpdateCheckResult {
  /** true = GitHub erreicht (auch „aktuell"); false = offline/Fehler. */
  ok: boolean;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  releaseUrl?: string;
  error?: string;
}

/** Die im Renderer als `window.gobdesk` verfügbare API. */
export interface GobdeskApi {
  getSettings(): Promise<CompanySettings | null>;
  updateSettings(input: CompanySettingsInput): Promise<void>;
  listCustomers(): Promise<Customer[]>;
  listCustomersDetailed(search?: string): Promise<CustomerListItem[]>;
  getCustomer(id: number): Promise<CustomerDetail | null>;
  createCustomer(input: CustomerInput): Promise<number>;
  updateCustomer(id: number, input: CustomerInput): Promise<void>;
  listTaxRates(): Promise<TaxRate[]>;
  listInvoices(filter?: InvoiceFilter): Promise<InvoiceListItem[]>;
  createDraftInvoice(input: DraftInvoiceInput): Promise<number>;
  updateDraftInvoice(id: number, input: DraftInvoiceInput): Promise<void>;
  issueInvoice(id: number): Promise<IssueInvoiceResult>;
  cancelInvoice(id: number, reason: string | null): Promise<CancelInvoiceResult>;
  previewInvoice(input: DraftInvoiceInput): Promise<Uint8Array>;
  validateInvoice(id: number): Promise<ValidationResult>;
  getInvoice(id: number): Promise<InvoiceDetail | null>;
  markInvoicePaid(id: number): Promise<void>;
  listOverdueInvoices(): Promise<OverdueInvoice[]>;
  exportDunning(invoiceId: number, level: number, feeCents: number): Promise<DunningResult>;
  addPayment(invoiceId: number, paidAt: string, amountCents: number, note: string | null): Promise<void>;
  deletePayment(paymentId: number): Promise<void>;
  openArtifact(invoiceId: number, kind: "pdf" | "xml"): Promise<void>;
  listEuerCategories(): Promise<EuerCategory[]>;
  createExpense(input: ExpenseInput): Promise<number>;
  getExpense(id: number): Promise<ExpenseDetail | null>;
  updateExpense(id: number, input: ExpenseInput): Promise<void>;
  listExpenses(year: number): Promise<ExpenseListItem[]>;
  listIncomeCategories(): Promise<EuerCategory[]>;
  createOtherIncome(input: OtherIncomeInput): Promise<number>;
  getOtherIncome(id: number): Promise<OtherIncomeDetail | null>;
  updateOtherIncome(id: number, input: OtherIncomeInput): Promise<void>;
  listOtherIncome(year: number): Promise<OtherIncomeListItem[]>;
  euerReport(year: number): Promise<EuerReport>;
  listEuerYears(): Promise<number[]>;
  runDemoInvoice(): Promise<DemoInvoiceResult>;
  gobdReport(): Promise<GobdReport>;
  gobdQuickCheck(): Promise<GobdQuickCheck>;
  listJournal(): Promise<JournalEntry[]>;
  listJournalForInvoice(invoiceId: number): Promise<JournalEntry[]>;
  exportJournal(): Promise<JournalExportResult>;
  exportZ3(): Promise<Z3ExportResult>;
  getVerfdokTexts(): Promise<Record<string, string>>;
  exportVerfahrensdok(
    format: VerfdokFormat,
    texts: Record<string, string>,
  ): Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
  getStorageInfo(): Promise<StorageInfo>;
  openDataDir(): Promise<void>;
  changeDataDir(): Promise<ChangeDataDirResult>;
  createBackup(): Promise<BackupResult>;
  importDocuments(): Promise<DocumentImportSummary>;
  importDocumentPaths(paths: string[]): Promise<DocumentImportSummary>;
  getPathForFile(file: File): string;
  listDocuments(filter?: DocumentFilter): Promise<DocumentListItem[]>;
  getDocument(id: number): Promise<DocumentDetail | null>;
  updateDocument(id: number, input: DocumentUpdateInput): Promise<void>;
  updateDocumentOcr(id: number, text: string): Promise<void>;
  archiveDocument(id: number, archived: boolean): Promise<void>;
  deleteDocument(id: number): Promise<void>;
  openDocument(id: number): Promise<void>;
  listDocumentTypes(): Promise<DocumentType[]>;
  listTags(): Promise<Tag[]>;
  linkDocument(documentId: number, targetType: DocumentTargetType, targetId: number): Promise<void>;
  unlinkDocument(linkId: number): Promise<void>;
  listLinkTargets(): Promise<LinkTargets>;
  listDocumentsForTarget(
    targetType: DocumentTargetType,
    targetId: number,
  ): Promise<DocumentListItem[]>;
  listOrders(filter?: OrderFilter): Promise<OrderListItem[]>;
  getOrder(id: number): Promise<OrderDetail | null>;
  createOrder(input: OrderInput): Promise<number>;
  updateOrder(id: number, input: OrderInput): Promise<void>;
  deleteOrder(id: number): Promise<void>;
  listOrderOptions(): Promise<OrderOption[]>;
  suggestOrderNumber(): Promise<string>;
  importDocumentsForOrder(orderId: number): Promise<DocumentImportSummary>;
  getAppInfo(): Promise<AppInfo>;
  checkForUpdate(): Promise<UpdateCheckResult>;
  openExternal(url: string): Promise<void>;
}
