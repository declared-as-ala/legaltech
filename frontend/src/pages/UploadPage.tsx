import { useCallback, useEffect, useMemo, useState } from "react";

import { getHealth } from "../api/client";
import {
  getDocument,
  getDocumentAnalysis,
  getDocumentEvaluation,
  getDocumentExtraction,
  getDocumentRecommendations,
  getDocumentRewrites,
  getDocumentSummary,
  listDocuments,
  retryDocumentExtraction,
  deleteDocument as apiDeleteDocument,
  uploadDocument,
} from "../api/documents";
import { AnalysisViewer } from "../components/AnalysisViewer";
import { DocumentHistoryList } from "../components/DocumentHistoryList";
import { DocumentStatusCard } from "../components/DocumentStatusCard";
import { EmptyWorkspaceState } from "../components/EmptyWorkspaceState";
import { EvaluationViewer } from "../components/EvaluationViewer";
import { AgentPipeline } from "../components/AgentPipeline";
import { RecommendationViewer } from "../components/RecommendationViewer";
import { RewriteReviewPanel } from "../components/RewriteReviewPanel";
import { ExtractionViewer } from "../components/ExtractionViewer";
import { FailedExtractionState } from "../components/FailedExtractionState";
import { ProgressCard } from "../components/ProgressCard";
import { QueueSummaryCards } from "../components/QueueSummaryCards";
import { UploadDropzone } from "../components/UploadDropzone";
import type {
  DocumentBaseResponse,
  DocumentDetailResponse,
  DocumentSummaryResponse,
  EvaluationResponse,
  ExtractionResponse,
  NLPAnalysisResponse,
  RecommendationsListResponse,
  RewritesListResponse,
} from "../types/documents";

const STORAGE_KEY = "agent1:selectedDocumentId";
const IN_PROGRESS = ["queued", "extracting", "analyzing", "evaluating", "recommending"];
const PIPELINE_UI_STATUSES = ["analyzed", "evaluating", "evaluated", "recommending", "complete"];
const RECOMMENDATION_FETCH_STATUSES = ["evaluated", "recommending", "complete"];
const REWRITE_UI_STATUSES = ["evaluated", "complete"];

const UPLOAD_ALLOWED_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".txt", ".html", ".htm",
  ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp",
]);

type AgentTab = "agent1" | "agent2" | "agent3" | "agent4";

// ── Tab definitions ─────────────────────────────────────────────────
const AGENT_TABS: { id: AgentTab; num: string; label: string; sublabel: string; icon: string }[] = [
  { id: "agent1", num: "01", label: "Extraction", sublabel: "Texte brut & structure", icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
  { id: "agent2", num: "02", label: "Analyse NLP", sublabel: "Clauses & entités", icon: "M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" },
  { id: "agent3", num: "03", label: "Conformité", sublabel: "Score & violations", icon: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" },
  { id: "agent4", num: "04", label: "Recommandations", sublabel: "Clauses révisées", icon: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" },
];

export function UploadPage() {
  const [documents, setDocuments] = useState<DocumentBaseResponse[]>([]);
  const [summary, setSummary] = useState<DocumentSummaryResponse | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<number | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<DocumentDetailResponse | null>(null);
  const [selectedExtraction, setSelectedExtraction] = useState<ExtractionResponse | null>(null);
  const [selectedAnalysis, setSelectedAnalysis] = useState<NLPAnalysisResponse | null>(null);
  const [selectedEvaluation, setSelectedEvaluation] = useState<EvaluationResponse | null>(null);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [selectedRecommendations, setSelectedRecommendations] = useState<RecommendationsListResponse | null>(null);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [rewritesData, setRewritesData] = useState<RewritesListResponse | null>(null);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const [agent4LlmEnabled, setAgent4LlmEnabled] = useState<boolean | null>(null);
  const [imageOcrSupported, setImageOcrSupported] = useState<boolean | null>(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<AgentTab>("agent1");

  const shouldPoll = useMemo(
    () =>
      documents.some((d) => IN_PROGRESS.includes(d.status)) ||
      (selectedDocument?.status != null && IN_PROGRESS.includes(selectedDocument.status)),
    [documents, selectedDocument?.status],
  );

  // Derive per-tab availability from current data
  const tabStatus = useMemo<Record<AgentTab, "done" | "active" | "pending">>(() => {
    const st = selectedDocument?.status ?? "";
    const hasAgent1 = !!selectedExtraction;
    const hasAgent2 = PIPELINE_UI_STATUSES.includes(st) && !!selectedAnalysis;
    const agent2Processing = st === "analyzing";
    const hasAgent3 = !!selectedEvaluation;
    const agent3Processing = st === "evaluating";
    const hasAgent4 = RECOMMENDATION_FETCH_STATUSES.includes(st) && !!selectedRecommendations;
    const agent4Processing = st === "recommending";

    return {
      agent1: hasAgent1 ? "done" : st === "extracting" ? "active" : "pending",
      agent2: hasAgent2 ? "done" : agent2Processing ? "active" : "pending",
      agent3: hasAgent3 ? "done" : agent3Processing ? "active" : "pending",
      agent4: hasAgent4 ? "done" : agent4Processing ? "active" : "pending",
    };
  }, [selectedDocument?.status, selectedExtraction, selectedAnalysis, selectedEvaluation, selectedRecommendations]);

  // Auto-advance to the latest completed tab
  useEffect(() => {
    const order: AgentTab[] = ["agent4", "agent3", "agent2", "agent1"];
    const latest = order.find((t) => tabStatus[t] === "done");
    if (latest) setActiveTab(latest);
  }, [tabStatus]);

  // Reset to agent1 when document changes
  useEffect(() => {
    setActiveTab("agent1");
  }, [selectedDocumentId]);

  const fetchRewrites = useCallback(async (documentId: number, status: string) => {
    if (!REWRITE_UI_STATUSES.includes(status)) {
      setRewritesData(null);
      setRewriteError(null);
      return;
    }
    try {
      const rw = await getDocumentRewrites(documentId);
      setRewritesData(rw);
      setRewriteError(null);
    } catch (e) {
      setRewritesData(null);
      setRewriteError(e instanceof Error ? e.message : "Échec du chargement des réécritures.");
    }
  }, []);

  const refreshWorkspace = useCallback(async (preferredId?: number | null) => {
    const [listResponse, summaryResponse] = await Promise.all([listDocuments(), getDocumentSummary()]);
    setDocuments(listResponse.items);
    setSummary(summaryResponse);
    setSelectedDocumentId((current) => {
      const storedId = preferredId ?? current ?? Number(window.localStorage.getItem(STORAGE_KEY));
      if (storedId && listResponse.items.some((item) => item.id === storedId)) return storedId;
      return listResponse.items[0]?.id ?? null;
    });
  }, []);

  const refreshSelectedDocument = useCallback(async (documentId: number) => {
    const [documentResponse, extractionResponse] = await Promise.all([
      getDocument(documentId),
      getDocumentExtraction(documentId),
    ]);
    setSelectedDocument(documentResponse);
    setSelectedExtraction(extractionResponse);
    if (PIPELINE_UI_STATUSES.includes(documentResponse.status)) {
      try {
        const analysisResponse = await getDocumentAnalysis(documentId);
        setSelectedAnalysis(analysisResponse);
      } catch {
        setSelectedAnalysis(null);
      }
    } else {
      setSelectedAnalysis(null);
    }
    if (PIPELINE_UI_STATUSES.includes(documentResponse.status)) {
      try {
        const evalResponse = await getDocumentEvaluation(documentId);
        setSelectedEvaluation(evalResponse);
        setEvaluationError(null);
      } catch (e) {
        setSelectedEvaluation(null);
        setEvaluationError(e instanceof Error ? e.message : "Failed to load Agent 3 evaluation.");
      }
    } else {
      setSelectedEvaluation(null);
      setEvaluationError(null);
    }
    if (RECOMMENDATION_FETCH_STATUSES.includes(documentResponse.status)) {
      try {
        const recResponse = await getDocumentRecommendations(documentId);
        setSelectedRecommendations(recResponse);
        setRecommendationError(null);
      } catch (e) {
        setSelectedRecommendations(null);
        setRecommendationError(e instanceof Error ? e.message : "Failed to load Agent 4 recommendations.");
      }
    } else {
      setSelectedRecommendations(null);
      setRecommendationError(null);
    }
    await fetchRewrites(documentId, documentResponse.status);
  }, [fetchRewrites]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await refreshWorkspace();
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (active) setLoadingWorkspace(false);
      }
    })();
    return () => { active = false; };
  }, [refreshWorkspace]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const h = await getHealth();
        if (!active) return;
        setAgent4LlmEnabled(Boolean(h.agent4_llm_enabled));
        if (typeof h.image_ocr_upload === "boolean") {
          setImageOcrSupported(h.image_ocr_upload);
        }
      } catch {
        if (active) {
          setAgent4LlmEnabled(null);
          setImageOcrSupported(null);
        }
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (selectedDocumentId == null) {
      setSelectedDocument(null);
      setSelectedExtraction(null);
      setSelectedAnalysis(null);
      setSelectedEvaluation(null);
      setEvaluationError(null);
      setSelectedRecommendations(null);
      setRecommendationError(null);
      setRewritesData(null);
      setRewriteError(null);
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, String(selectedDocumentId));
    let active = true;
    (async () => {
      try {
        const [doc, ext] = await Promise.all([
          getDocument(selectedDocumentId),
          getDocumentExtraction(selectedDocumentId),
        ]);
        if (!active) return;
        setSelectedDocument(doc);
        setSelectedExtraction(ext);
        if (PIPELINE_UI_STATUSES.includes(doc.status)) {
          try {
            const analysis = await getDocumentAnalysis(selectedDocumentId);
            if (active) setSelectedAnalysis(analysis);
          } catch {
            if (active) setSelectedAnalysis(null);
          }
        } else {
          if (active) setSelectedAnalysis(null);
        }
        if (PIPELINE_UI_STATUSES.includes(doc.status)) {
          try {
            const evaluation = await getDocumentEvaluation(selectedDocumentId);
            if (active) setSelectedEvaluation(evaluation);
            if (active) setEvaluationError(null);
          } catch (e) {
            if (active) setSelectedEvaluation(null);
            if (active) setEvaluationError(e instanceof Error ? e.message : "Failed to load Agent 3 evaluation.");
          }
        } else {
          if (active) setSelectedEvaluation(null);
          if (active) setEvaluationError(null);
        }
        if (RECOMMENDATION_FETCH_STATUSES.includes(doc.status)) {
          try {
            const recs = await getDocumentRecommendations(selectedDocumentId);
            if (active) setSelectedRecommendations(recs);
            if (active) setRecommendationError(null);
          } catch (e) {
            if (active) setSelectedRecommendations(null);
            if (active) setRecommendationError(e instanceof Error ? e.message : "Failed to load Agent 4 recommendations.");
          }
        } else {
          if (active) setSelectedRecommendations(null);
          if (active) setRecommendationError(null);
        }
        if (active) await fetchRewrites(selectedDocumentId, doc.status);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Unknown error");
      }
    })();
    return () => { active = false; };
  }, [selectedDocumentId, fetchRewrites]);

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(async () => {
      try {
        await refreshWorkspace(selectedDocumentId);
        if (selectedDocumentId != null) await refreshSelectedDocument(selectedDocumentId);
      } catch { /* keep existing state on poll failure */ }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshSelectedDocument, refreshWorkspace, selectedDocumentId, shouldPoll]);

  const handleFilesSelect = async (files: File[]) => {
    setError(null);
    for (const file of files) {
      const dot = file.name.lastIndexOf(".");
      const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
      if (!UPLOAD_ALLOWED_EXTENSIONS.has(ext)) {
        setError(`Type de fichier non supporté (${ext || "sans extension"}) : ${file.name}`);
        return;
      }
    }
    setUploading(true);
    let lastId: number | null = null;
    try {
      for (const file of files) {
        const res = await uploadDocument(file);
        lastId = res.id;
      }
      await refreshWorkspace(lastId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Téléversement échoué");
    } finally {
      setUploading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await refreshWorkspace(selectedDocumentId);
      if (selectedDocumentId != null) await refreshSelectedDocument(selectedDocumentId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Actualisation échouée");
    } finally {
      setRefreshing(false);
    }
  };

  const handleRetry = async () => {
    if (selectedDocumentId == null) return;
    setRetrying(true);
    setError(null);
    try {
      await retryDocumentExtraction(selectedDocumentId);
      await refreshWorkspace(selectedDocumentId);
      await refreshSelectedDocument(selectedDocumentId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Relance échouée");
    } finally {
      setRetrying(false);
    }
  };

  const handleDelete = async (documentId: number) => {
    const doc = documents.find((d) => d.id === documentId);
    if (!doc) return;
    if (IN_PROGRESS.includes(doc.status)) {
      setError("Impossible de supprimer un document en cours de traitement.");
      return;
    }
    setDeletingId(documentId);
    setError(null);
    try {
      await apiDeleteDocument(documentId);
      if (documentId === selectedDocumentId) {
        setSelectedDocument(null);
        setSelectedExtraction(null);
        setSelectedAnalysis(null);
        setSelectedEvaluation(null);
        setEvaluationError(null);
        setSelectedRecommendations(null);
        setRecommendationError(null);
      }
      await refreshWorkspace();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Suppression échouée");
    } finally {
      setDeletingId(null);
    }
  };

  // ── Tab navigation helpers ──────────────────────────────────────
  const currentTabIndex = AGENT_TABS.findIndex((t) => t.id === activeTab);

  const goNext = () => {
    if (currentTabIndex < AGENT_TABS.length - 1)
      setActiveTab(AGENT_TABS[currentTabIndex + 1].id);
  };
  const goPrev = () => {
    if (currentTabIndex > 0)
      setActiveTab(AGENT_TABS[currentTabIndex - 1].id);
  };

  const hasContent = selectedDocument != null && selectedDocument.status !== "failed";

  return (
    <main className="relative min-h-screen overflow-hidden text-stone-900">
      <div className="pointer-events-none fixed inset-0 lex-glow-hero" aria-hidden />
      <div className="pointer-events-none fixed inset-0 lex-grid-bg opacity-60" aria-hidden />

      <div className="relative mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8 lg:py-10">

        {/* ── Header ── */}
        <header className="lex-panel animate-slide-up overflow-hidden">
          <div className="h-1 w-full bg-gradient-to-r from-gold-600 via-gold-400 to-gold-300" />
          <div className="p-6 sm:p-8">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 max-w-2xl">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-gold-500 to-gold-400 shadow-[0_4px_16px_rgba(201,163,54,0.40)]">
                    <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v17.25m0 0c-1.472 0-2.882.265-4.185.75M12 20.25c1.472 0 2.882.265 4.185.75M18.75 4.97A48.416 48.416 0 0012 4.5c-2.291 0-4.545.16-6.75.47m13.5 0c1.01.143 2.01.317 3 .52m-3-.52l2.62 10.726c.122.499-.106 1.028-.589 1.202a5.988 5.988 0 01-2.031.352 5.988 5.988 0 01-2.031-.352c-.483-.174-.711-.703-.59-1.202L18.75 4.97z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-gold-600">LexAI</p>
                    <h1 className="lex-title -mt-0.5 text-xl font-semibold text-stone-900 sm:text-2xl">
                      Compliance Command Center
                    </h1>
                  </div>
                </div>
                <p className="mt-3 max-w-lg text-sm leading-relaxed text-stone-500">
                  Pipeline IA complet : extraction documentaire, analyse NLP des clauses,
                  évaluation de conformité{" "}
                  <span className="font-medium text-stone-700">LNPDP · RGPD · ISO 27001</span>,
                  et recommandations de remédiation.
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {["LNPDP 2004-63", "RGPD EU 2016/679", "ISO 27001:2022", "ISO 9001:2015"].map((fw) => (
                    <span key={fw} className="rounded-full border border-gold-300/50 bg-amber-50 px-2.5 py-0.5 text-[10px] font-semibold text-gold-700">
                      {fw}
                    </span>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                className="group inline-flex shrink-0 items-center justify-center gap-2 self-start rounded-xl border border-gold-300/50 bg-white px-5 py-2.5 text-sm font-semibold text-stone-700 shadow-sm transition-all duration-200 hover:border-gold-400/70 hover:bg-amber-50 hover:text-gold-800 disabled:opacity-50"
              >
                <svg className={`h-4 w-4 text-gold-500 transition-transform duration-500 ${refreshing ? "animate-spin" : "group-hover:rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                {refreshing ? "Synchronisation…" : "Actualiser"}
              </button>
            </div>
            <div className="mt-6 border-t border-gold-200/40 pt-6">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-stone-400">Pipeline en direct</p>
              <div className="mt-4">
                <AgentPipeline status={selectedDocument?.status} />
              </div>
            </div>
          </div>
        </header>

        {/* ── Error banner ── */}
        {error && (
          <div role="alert" className="animate-slide-up flex items-start gap-3 rounded-xl border border-rose-300/50 bg-rose-50 px-4 py-3.5">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            <p className="flex-1 text-sm leading-relaxed text-rose-800">{error}</p>
            <button type="button" onClick={() => setError(null)} className="shrink-0 rounded-lg p-1 text-rose-400 transition hover:bg-rose-100 hover:text-rose-600">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* ── Main grid ── */}
        <div className="grid gap-6 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)] xl:items-start">

          {/* ── Left sidebar ── */}
          <aside className="flex flex-col gap-4">
            <UploadDropzone
              onFilesSelect={handleFilesSelect}
              loading={uploading}
              agent4LlmEnabled={agent4LlmEnabled}
              imageOcrSupported={imageOcrSupported}
            />
            <QueueSummaryCards summary={summary} />
            <DocumentHistoryList
              documents={documents}
              selectedDocumentId={selectedDocumentId}
              onSelect={setSelectedDocumentId}
              onDelete={handleDelete}
              deletingId={deletingId}
              loading={loadingWorkspace}
            />
          </aside>

          {/* ── Right content ── */}
          <section className="flex min-w-0 flex-col gap-4">
            {documents.length === 0 && !loadingWorkspace ? (
              <EmptyWorkspaceState />
            ) : (
              <>
                {/* Status + progress (always visible) */}
                <DocumentStatusCard document={selectedDocument} />
                <ProgressCard document={selectedDocument} />

                {selectedDocument?.status === "failed" ? (
                  <FailedExtractionState
                    error={selectedDocument.last_error}
                    onRetry={handleRetry}
                    retrying={retrying}
                  />
                ) : hasContent ? (
                  /* ── Agent tab panel ── */
                  <div className="lex-panel overflow-hidden">
                    {/* Tab bar */}
                    <div className="border-b border-gold-200/40 bg-gradient-to-r from-amber-50/60 to-white px-4 pt-4">
                      <div className="flex gap-1 overflow-x-auto pb-px">
                        {AGENT_TABS.map((tab, idx) => {
                          const st = tabStatus[tab.id];
                          const isActive = activeTab === tab.id;
                          const isDone = st === "done";
                          const isProcessing = st === "active";

                          return (
                            <button
                              key={tab.id}
                              type="button"
                              onClick={() => setActiveTab(tab.id)}
                              className={[
                                "group relative flex min-w-0 shrink-0 items-center gap-2.5 rounded-t-lg px-4 py-2.5 text-left transition-all duration-200",
                                isActive
                                  ? "bg-white text-stone-900 shadow-[0_-1px_0_0_inset] shadow-gold-400"
                                  : "text-stone-500 hover:bg-white/60 hover:text-stone-700",
                              ].join(" ")}
                            >
                              {/* Status dot / spinner */}
                              <span className={[
                                "relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                                isDone
                                  ? "bg-emerald-100 text-emerald-600"
                                  : isProcessing
                                  ? "bg-gold-100 text-gold-600"
                                  : isActive
                                  ? "bg-gold-100 text-gold-600"
                                  : "bg-stone-100 text-stone-400",
                              ].join(" ")}>
                                {isDone ? (
                                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                  </svg>
                                ) : isProcessing ? (
                                  <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                  </svg>
                                ) : (
                                  <span>{idx + 1}</span>
                                )}
                              </span>

                              <span className="hidden min-w-0 sm:block">
                                <span className={[
                                  "block text-xs font-bold leading-none",
                                  isActive ? "text-gold-700" : "",
                                ].join(" ")}>
                                  {tab.label}
                                </span>
                                <span className="mt-0.5 block truncate text-[10px] text-stone-400 leading-none">
                                  {tab.sublabel}
                                </span>
                              </span>

                              {/* Active underline */}
                              {isActive && (
                                <span className="absolute bottom-0 left-0 h-0.5 w-full rounded-full bg-gold-500" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Tab content */}
                    <div className="p-4 sm:p-6">

                      {/* Agent 1 */}
                      {activeTab === "agent1" && (
                        <ExtractionViewer extraction={selectedExtraction} document={selectedDocument} />
                      )}

                      {/* Agent 2 */}
                      {activeTab === "agent2" && (
                        tabStatus.agent2 === "pending" && tabStatus.agent1 !== "done" ? (
                          <PendingAgentPlaceholder
                            num="02"
                            label="Analyse NLP"
                            message="En attente de la fin de l'extraction (Agent 1)."
                          />
                        ) : tabStatus.agent2 === "pending" ? (
                          <PendingAgentPlaceholder
                            num="02"
                            label="Analyse NLP"
                            message="L'analyse NLP démarrera automatiquement après l'extraction."
                          />
                        ) : tabStatus.agent2 === "active" ? (
                          <ProcessingAgentPlaceholder label="Analyse NLP en cours…" />
                        ) : (
                          <AnalysisViewer analysis={selectedAnalysis} />
                        )
                      )}

                      {/* Agent 3 */}
                      {activeTab === "agent3" && (
                        evaluationError ? (
                          <div role="status" className="rounded-xl border border-amber-300/50 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                            Évaluation Agent 3 non disponible : {evaluationError}
                          </div>
                        ) : tabStatus.agent3 === "pending" ? (
                          <PendingAgentPlaceholder
                            num="03"
                            label="Évaluation de conformité"
                            message="L'évaluation démarrera automatiquement après l'analyse NLP."
                          />
                        ) : tabStatus.agent3 === "active" ? (
                          <ProcessingAgentPlaceholder label="Évaluation de conformité en cours…" />
                        ) : selectedEvaluation ? (
                          <EvaluationViewer evaluation={selectedEvaluation} />
                        ) : null
                      )}

                      {/* Agent 4 */}
                      {activeTab === "agent4" && (
                        recommendationError && RECOMMENDATION_FETCH_STATUSES.includes(selectedDocument?.status ?? "") ? (
                          <div role="status" className="rounded-xl border border-amber-300/50 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                            Recommandations Agent 4 : {recommendationError}
                          </div>
                        ) : tabStatus.agent4 === "pending" ? (
                          <PendingAgentPlaceholder
                            num="04"
                            label="Recommandations"
                            message="Les recommandations seront générées automatiquement après l'évaluation de conformité."
                          />
                        ) : tabStatus.agent4 === "active" ? (
                          <ProcessingAgentPlaceholder label="Génération des recommandations en cours…" />
                        ) : selectedDocument != null && RECOMMENDATION_FETCH_STATUSES.includes(selectedDocument.status) ? (
                          <>
                            <RecommendationViewer
                              documentId={selectedDocument.id}
                              status={selectedDocument.status}
                              agent4LlmEnabled={agent4LlmEnabled}
                              data={
                                selectedRecommendations ?? {
                                  document_id: selectedDocument.id,
                                  total: 0,
                                  recommendations: [],
                                }
                              }
                            />
                            {REWRITE_UI_STATUSES.includes(selectedDocument.status) && (
                              <div className="mt-4">
                                <RewriteReviewPanel
                                  documentId={selectedDocument.id}
                                  data={rewritesData}
                                  loadError={rewriteError}
                                  onRefresh={async () => {
                                    await fetchRewrites(selectedDocument.id, selectedDocument.status);
                                  }}
                                />
                              </div>
                            )}
                          </>
                        ) : null
                      )}
                    </div>

                    {/* Bottom nav — Prev / Next */}
                    <div className="flex items-center justify-between border-t border-gold-200/30 bg-amber-50/40 px-4 py-3 sm:px-6">
                      <button
                        type="button"
                        onClick={goPrev}
                        disabled={currentTabIndex === 0}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-semibold text-stone-600 shadow-sm transition hover:border-gold-300 hover:text-gold-700 disabled:pointer-events-none disabled:opacity-30"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                        {currentTabIndex > 0 ? AGENT_TABS[currentTabIndex - 1].label : "Précédent"}
                      </button>

                      {/* Dots */}
                      <div className="flex items-center gap-1.5">
                        {AGENT_TABS.map((tab, idx) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setActiveTab(tab.id)}
                            className={[
                              "rounded-full transition-all duration-200",
                              activeTab === tab.id
                                ? "h-2 w-5 bg-gold-500"
                                : tabStatus[tab.id] === "done"
                                ? "h-2 w-2 bg-emerald-400"
                                : "h-2 w-2 bg-stone-200 hover:bg-stone-300",
                            ].join(" ")}
                            aria-label={tab.label}
                          />
                        ))}
                      </div>

                      <button
                        type="button"
                        onClick={goNext}
                        disabled={currentTabIndex === AGENT_TABS.length - 1}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-semibold text-stone-600 shadow-sm transition hover:border-gold-300 hover:text-gold-700 disabled:pointer-events-none disabled:opacity-30"
                      >
                        {currentTabIndex < AGENT_TABS.length - 1 ? AGENT_TABS[currentTabIndex + 1].label : "Suivant"}
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

// ── Helper placeholders ──────────────────────────────────────────────

function PendingAgentPlaceholder({ num, label, message }: { num: string; label: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border-2 border-dashed border-stone-200 bg-stone-50 text-xl font-bold text-stone-300">
        {num}
      </div>
      <p className="text-sm font-semibold text-stone-500">{label}</p>
      <p className="max-w-xs text-xs text-stone-400">{message}</p>
    </div>
  );
}

function ProcessingAgentPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50">
        <svg className="h-7 w-7 animate-spin text-gold-500" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
      <p className="text-sm font-semibold text-gold-700">{label}</p>
      <p className="text-xs text-stone-400">Mise à jour automatique toutes les 2 secondes.</p>
    </div>
  );
}
