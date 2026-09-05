import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { CommandLogPanel } from "./components/commandlog/CommandLogPanel";
import { CommitList } from "./components/commits/CommitList";
import { CommitInfo } from "./components/diff/CommitInfo";
import { DiffPane } from "./components/diff/DiffPane";
import {
  rangeSource,
  useCommitFiles,
  type DiffScope,
} from "./components/diff/useCommitFiles";
import { useWorkingTree } from "./components/diff/useWorkingTree";
import { WorkingTreeFiles } from "./components/diff/WorkingTreeFiles";
import { useFileNavigation } from "./hooks/useFileNavigation";
import {
  entryKey,
  isClean,
  parseKey,
  stillListed,
  summarize,
  workingEntries,
  type WorkingSelection,
} from "./lib/workingTree";
import { CommandPalette } from "./components/common/CommandPalette";
import { FetchConfirm, FetchDialog } from "./components/common/ProgressDialog";
import { WriteOpsDialog, WriteOpsResult } from "./components/common/WriteOpsDialog";
import { LoadProgress } from "./components/common/LoadProgress";
import { NoticeBar } from "./components/common/NoticeBar";
import { SplitPane } from "./components/common/SplitPane";
import { RefTree } from "./components/sidebar/RefTree";
import { RepositoryList, type SortMode } from "./components/sidebar/RepositoryList";
import { Sidebar } from "./components/sidebar/Sidebar";
import { LlmProfilesDialog } from "./components/settings/LlmProfiles";
import { CloneDialog } from "./components/setup/CloneDialog";
import { EmptyState } from "./components/setup/EmptyState";
import { GitSetupScreen } from "./components/setup/GitSetupScreen";
import { useCommandLog } from "./hooks/useCommandLog";
import { useClone } from "./hooks/useClone";
import { useFetch } from "./hooks/useFetch";
import { useWriteOps, type CheckoutSubject } from "./hooks/useWriteOps";
import { checkoutChoices, checkoutCommit, type CheckoutChoice } from "./lib/writeOps";
import { useTheme, type ThemePreference } from "./hooks/useTheme";
import { ja } from "./i18n/ja";
import { clearCompare, selectCommit, swapEnds } from "./lib/compareSelection";
import {
  detectGit,
  isGitUsable,
  loadCommitMessage,
  MIN_VERSION_FALLBACK,
  type ColumnWidths,
  type CommitMeta,
  type DiffSource,
  type GitStatus,
  type LoadPhase,
  type RefEntry,
  type RepositoryEntry,
  type UiSettings,
} from "./lib/ipc";
import * as repositories from "./store/repositories";
import { useRepositories } from "./store/repositories";
import {
  dismissSettingsNotice,
  initSettings,
  refreshSettings,
  updateSettings,
  useSettings,
} from "./store/settings";
import * as snapshots from "./store/snapshot";
import { useSnapshot } from "./store/snapshot";
import {
  DEFAULT_REPOSITORY_UI_STATE,
  initUiState,
  updateRepositoryUiState,
  updateUiState,
  useUiState,
} from "./store/uiState";

/**
 * 進捗バーを出し始めるまでの時間。
 *
 * 数万コミットなら読み込みは 1 秒未満で終わる。そこでバーを出しても
 * 一瞬光って消えるだけで、かえって落ち着かない。
 */
const SLOW_LOAD_MS = 400;

/** サイドバー幅の可動域。狭すぎるとパスが読めず、広すぎると本体が潰れる。 */
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 560;

/** 右のコミット情報ペイン幅の可動域。狭すぎると facts が折り返しだらけになる。 */
const COMMIT_INFO_MIN = 240;
const COMMIT_INFO_MAX = 720;

export default function App() {
  const [theme, setTheme] = useTheme();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [logOpen, setLogOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /**
   * AI レビューの接続先（T-20）。**T-25 でこの中身を設定画面へ移す**ので、
   * いまは入口をヘッダのボタン 1 つに留めておく。
   */
  const [llmOpen, setLlmOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * ブランチツリーから「先頭コミットへジャンプ」したときの要求。
   *
   * 選択そのものは `state.json` の `selectedCommit` が正なので、ここで持つのは
   * **スクロールさせる合図**だけ。同じブランチを続けて選んでも効くよう連番を添える。
   */
  const [jumpTo, setJumpTo] = useState<{ sha: string; nonce: number } | null>(null);

  const entries = useCommandLog();
  const settings = useSettings();
  const { state: uiState } = useUiState();
  const repos = useRepositories();

  const recheck = useCallback(async (path?: string) => {
    setDetecting(true);
    try {
      setStatus(await detectGit(path));
    } catch (error) {
      // バックエンドに到達できない場合も「git を確認できていない」状態として扱う。
      // ここで握らないと status が null のままになり、確認中の表示から戻らなくなる。
      setStatus({
        found: false,
        path: path?.trim() || "git",
        version: null,
        versionOk: false,
        minVersion: MIN_VERSION_FALLBACK,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDetecting(false);
    }
  }, []);

  // StrictMode の二重実行で git を 2 回起動しないようにする。
  const detected = useRef(false);
  useEffect(() => {
    if (detected.current) return;
    detected.current = true;
    void recheck();
  }, [recheck]);

  // 設定 → UI 状態 → リポジトリの順に読む。
  // リポジトリの復元が state.json の lastRepositoryId に依存しているため順序が要る。
  useEffect(() => {
    void (async () => {
      await Promise.all([initSettings(), initUiState()]);
      await repositories.initRepositories();
    })();
  }, []);

  // リポジトリを選んだら全コミットを一括で読む（docs/DESIGN.md §4.1）。
  // 直前のリポジトリの分は Rust 側の LRU に残っているので、戻りは体感即時になる。
  useEffect(() => {
    // 可視 ref はリポジトリごとの設定（settings.json）。切替のたびに読み直す。
    const visible = repositories.selectedRepository()?.visibleRefs;
    void snapshots.load(repos.selectedId, false, false, visible);
  }, [repos.selectedId]);

  const sortMode = uiState.repositoryListSort;
  const sorted = repositories.sortedEntries(repos.entries, sortMode);
  const selected = sorted.find((entry) => entry.id === repos.selectedId) ?? null;

  // `fetch` は window の同名関数と紛れるので別の名前にする。
  const fetching = useFetch();
  // clone（T-19）。**成功したら登録してそのまま開く**ので、報告はバナー 1 行で足りる。
  const cloning = useClone(setMessage);
  /**
   * 選んだコミットを画面内へ寄せる。**連番を上げて「新しい依頼」だと分からせる。**
   * 同じ SHA をもう一度指しても動くようにするため。
   */
  const revealCommit = useCallback((sha: string) => {
    setJumpTo((current) => ({ sha, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  /**
   * 書き込みのあとは **HEAD へ寄せる**（T-18）。
   *
   * checkout は HEAD を動かすので、そのままだと選択行が古い場所に取り残される。
   * 少し古いブランチへ切り替えたときは数百行離れることもあり、**自分がどこにいるか
   * 見失う**（利用者の指摘）。読み直しが終わってから呼ぶこと。
   */
  const goToHead = useCallback(() => {
    const head = snapshots.currentHeadSha();
    if (head !== null) revealCommit(head);
  }, [revealCommit]);

  // checkout と FF マージ（T-18）。**判定 → 確認 → 実行 → 読み直しの 1 本だけ。**
  const writing = useWriteOps(repos.selectedId, goToHead);
  // **個別のコールバックを取り出して使う。** `fetching` は毎回新しい object なので、
  // それを依存に置くと `keydown` の登録・解除が毎レンダリング走る。
  const { fetchOne: startFetch, askAll } = fetching;

  /** fetch できる相手だけを集める。リモートが無いリポジトリは一括の対象にしない。 */
  const fetchTargets = useMemo(
    () =>
      sorted
        .filter((entry) => (entry.probe?.remotes.length ?? 0) > 0)
        .map((entry) => ({ id: entry.id, name: entry.name })),
    [sorted],
  );

  const fetchOne = useCallback(
    (id: string) => {
      const entry = repos.entries.find((candidate) => candidate.id === id);
      if (entry === undefined) return;
      startFetch({ id: entry.id, name: entry.name });
    },
    [repos.entries, startFetch],
  );

  // Ctrl+P でリポジトリ切替、Ctrl+R / Ctrl+Shift+R で fetch（docs/DESIGN.md §6.5）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 入力欄では横取りしない（他のショートカットと同じ扱い）。
      if (isTyping(event.target)) return;

      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
        return;
      }

      // **`Ctrl+R` は WebView のページ再読込に取られる。** 必ず握り潰すこと。
      if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        if (event.shiftKey) askAll(fetchTargets);
        else if (repos.selectedId !== null) fetchOne(repos.selectedId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [askAll, fetchTargets, fetchOne, repos.selectedId]);

  const pickFolder = async (title: string): Promise<string | null> => {
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  };

  const handleAdd = async () => {
    const path = await pickFolder(ja.repositories.selectFolder);
    if (path !== null) await repositories.add(path);
  };

  const handleScan = async () => {
    const root = await pickFolder(ja.repositories.selectScanRoot);
    if (root === null) return;
    const added = await repositories.scanAndAdd(root);
    setMessage(added === 0 ? ja.repositories.scanNotFound : ja.repositories.scanFound(added));
  };

  const handleRelocate = async (id: string) => {
    const path = await pickFolder(ja.repositories.selectFolder);
    if (path !== null) await repositories.relocate(id, path);
  };

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__name">{ja.app.name}</span>
        <span className="app__tagline">{ja.app.tagline}</span>
        <div className="app__spacer" />
        <label className="app__theme">
          {ja.theme.label}
          <select
            className="select"
            value={theme}
            onChange={(event) => setTheme(event.target.value as ThemePreference)}
          >
            <option value="system">{ja.theme.system}</option>
            <option value="light">{ja.theme.light}</option>
            <option value="dark">{ja.theme.dark}</option>
          </select>
        </label>
        <button type="button" className="button" onClick={() => setLogOpen((open) => !open)}>
          {logOpen ? ja.commandLog.hide : ja.commandLog.show}
        </button>
        {/* AI レビューの接続先（T-20）。**入口は 1 つだけ**にして、
            T-25 で中身を設定画面へ移す。 */}
        <button type="button" className="button" onClick={() => setLlmOpen(true)}>
          {ja.llm.open}
        </button>
      </header>

      {settings.recovered !== null && (
        <NoticeBar
          title={ja.settings.recoveredTitle}
          detail={ja.settings.recoveredDetail(
            settings.recovered.backupPath,
            settings.recovered.reason,
          )}
          onDismiss={dismissSettingsNotice}
        />
      )}
      {settings.error !== null && (
        <NoticeBar
          title={
            settings.errorKind === "save"
              ? ja.settings.saveFailedTitle
              : ja.settings.loadFailedTitle
          }
          detail={settings.error}
          onDismiss={dismissSettingsNotice}
        />
      )}
      {repos.error !== null && (
        <NoticeBar title={repos.error} onDismiss={() => void repositories.refresh()} />
      )}
      {message !== null && <NoticeBar title={message} onDismiss={() => setMessage(null)} />}

      <main className="app__main">
        {status === null ? (
          <p className="app__loading">{ja.setup.detecting}</p>
        ) : isGitUsable(status) ? (
          <SplitPane
            direction="row"
            unit="px"
            size={uiState.paneRatios.sidebarWidth}
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            onSizeChange={(width) =>
              updateUiState((current) => ({
                ...current,
                paneRatios: { ...current.paneRatios, sidebarWidth: width },
              }))
            }
            first={
              <Sidebar
                repositories={
                  <RepositoryList
                    entries={sorted}
                    selectedId={repos.selectedId}
                    sortMode={sortMode}
                    busy={repos.busy}
                    onSelect={repositories.select}
                    onAdd={() => void handleAdd()}
                    onScan={() => void handleScan()}
                    onRemove={(id) => void repositories.remove(id)}
                    onRelocate={(id) => void handleRelocate(id)}
                    onSortModeChange={(mode: SortMode) =>
                      updateUiState((current) => ({ ...current, repositoryListSort: mode }))
                    }
                    onReorder={(ids) => void repositories.reorder(ids)}
                    onFetch={fetchOne}
                    onFetchAll={() => askAll(fetchTargets)}
                    onClone={cloning.show}
                  />
                }
                refs={
                  selected === null ? null : (
                    <RefTreePanel
                      entry={selected}
                      onJump={revealCommit}
                      onCheckout={writing.askCheckout}
                      onMerge={writing.askMerge}
                      onNotice={setMessage}
                    />
                  )
                }
              />
            }
            second={
              repos.loaded && repos.entries.length === 0 ? (
                <EmptyState
                  busy={repos.busy}
                  onAdd={() => void handleAdd()}
                  onScan={() => void handleScan()}
                  onClone={cloning.show}
                />
              ) : (
                <RepositoryPanel
                  entry={selected}
                  jumpTo={jumpTo}
                  onCheckoutCommit={(sha) =>
                    writing.askCheckout(
                      { kind: "commit", name: sha.slice(0, 8) },
                      [
                        {
                          target: checkoutCommit(sha),
                          primary: true,
                          kind: "detach",
                          name: sha.slice(0, 8),
                        },
                      ],
                    )
                  }
                  onCheckoutRef={writing.askCheckout}
                  onMergeRef={writing.askMerge}
                  onNotice={setMessage}
                />
              )
            }
          />
        ) : (
          <GitSetupScreen
            status={status}
            busy={detecting}
            onRecheck={(path) => void recheck(path)}
          />
        )}
      </main>

      {logOpen && <CommandLogPanel entries={entries} />}

      {/* fetch の確認と進行（docs/DESIGN.md §8.3）。**一括のときだけ確認を 1 回。** */}
      {fetching.pending !== null && (
        <FetchConfirm
          targets={fetching.pending}
          onConfirm={() => fetching.confirmAll(fetching.pending ?? [])}
          onCancel={fetching.dismiss}
        />
      )}

      {fetching.run !== null && (
        <FetchDialog
          run={fetching.run}
          progress={fetching.progress}
          onCancel={fetching.cancel}
          onClose={fetching.dismiss}
        />
      )}

      {/* AI レビューの接続先（T-20）。**API キーは資格情報マネージャーへ預ける。** */}
      {llmOpen && (
        <LlmProfilesDialog
          profiles={settings.settings.llmProfiles}
          onChanged={refreshSettings}
          onClose={() => setLlmOpen(false)}
        />
      )}

      {/* clone（T-19。docs/DESIGN.md §8.4）。**成功したら黙って閉じて開く。** */}
      {cloning.open && (
        <CloneDialog
          defaultParent={settings.settings.workspaceRoot}
          busy={cloning.busy}
          cancelling={cloning.cancelling}
          progress={cloning.progress}
          outcome={cloning.outcome}
          onPickParent={() => pickFolder(ja.clone.parentLabel)}
          onStart={cloning.start}
          onCancel={cloning.cancel}
          onBack={cloning.back}
          onClose={cloning.dismiss}
        />
      )}

      {/* checkout と FF マージ（T-18。docs/DESIGN.md §8.1, §8.2）。
          **確認は必ず出る。** 押せない理由もここに出す。 */}
      {writing.request !== null && (
        <WriteOpsDialog
          request={writing.request}
          onCheckout={writing.doCheckout}
          onMerge={writing.doMerge}
          onCancel={writing.dismiss}
        />
      )}

      {(writing.busy || writing.outcome !== null) && (
        <WriteOpsResult
          outcome={writing.outcome ?? EMPTY_OUTCOME}
          busy={writing.busy}
          onClose={writing.dismiss}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          entries={sorted}
          onSelect={(id) => {
            repositories.select(id);
            setPaletteOpen(false);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * 入力欄にフォーカスがあるか。**ショートカットを横取りしない**ための判定
 * （`useCommitNavigation` / `useFileNavigation` と同じ扱い）。
 */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (element === null) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable === true;
}

/**
 * サイドバー下段のブランチ / タグツリー。
 *
 * チェックの結果は `settings.json` の `repositories[].visibleRefs`、
 * 開閉は `state.json` の `collapsedTreeNodes` に、どちらもリポジトリごとに残る。
 * 履歴を読み終えるまでは ref 一覧が無いので何も出さない。
 */
function RefTreePanel({
  entry,
  onJump,
  onCheckout,
  onMerge,
  onNotice,
}: {
  entry: RepositoryEntry;
  onJump: (sha: string) => void;
  /** checkout の確認。**選択肢を決めるのは `lib/writeOps.ts`**（純関数）。 */
  onCheckout: (subject: CheckoutSubject, choices: CheckoutChoice[]) => void;
  onMerge: (rev: string, revLabel: string, revSha: string, branch: string | null) => void;
  onNotice: (message: string) => void;
}) {
  const snapshot = useSnapshot();
  const { state: uiState } = useUiState();

  const data = snapshot.data;
  if (snapshot.repositoryId !== entry.id || data === null) return null;

  const perRepository = uiState.perRepository[entry.id] ?? DEFAULT_REPOSITORY_UI_STATE;

  return (
    <RefTree
      refs={data.refs}
      head={data.head}
      branchStatus={snapshot.branchStatus}
      visibleRefs={snapshot.visibleRefs}
      collapsed={perRepository.collapsedTreeNodes}
      onVisibleRefsChange={(next) => void repositories.setVisibleRefs(entry.id, next)}
      onCollapsedChange={(next) =>
        updateRepositoryUiState(entry.id, (current) => ({
          ...current,
          collapsedTreeNodes: next,
        }))
      }
      onJump={onJump}
      onCheckout={(target) => askCheckoutRef(target, data.refs, onCheckout)}
      onMerge={(target) => askMergeRef(target, data.head.branch, onMerge)}
      onNotice={onNotice}
    />
  );
}

/**
 * ref を checkout の確認へ渡す。**ref ツリーとグラフのチップで同じものを使う。**
 *
 * 起動点ごとに書くと、片方だけ「ローカルブランチを作る」を出し忘れる。
 */
export function askCheckoutRef(
  entry: RefEntry,
  refs: RefEntry[],
  ask: (subject: CheckoutSubject, choices: CheckoutChoice[]) => void,
): void {
  ask({ kind: SUBJECT_KIND[entry.kind], name: entry.shortName }, checkoutChoices(entry, refs));
}

/** ref を FF マージの確認へ渡す。**git へ渡すのは完全な ref 名。** */
export function askMergeRef(
  entry: RefEntry,
  headBranch: string | null,
  ask: (rev: string, revLabel: string, revSha: string, branch: string | null) => void,
): void {
  ask(entry.name, entry.shortName, entry.target, headBranch);
}

/** ref の種別を確認画面の文面の種別へ。**タグとコミットで言うことが違う。** */
const SUBJECT_KIND: Record<RefEntry["kind"], CheckoutSubject["kind"]> = {
  localBranch: "branch",
  remoteBranch: "remote",
  tag: "tag",
};

/** 実行中はまだ結果が無い。**器だけ先に出して「実行しています…」を見せる。** */
const EMPTY_OUTCOME = { ok: false, message: "", details: [], refused: null };

/**
 * 選択中リポジトリの中身。
 *
 * 履歴を読み終えていればコミットリストを、そうでなければ素性と読み込み状態の
 * カードを出す。読み終わっていれば 3 ペイン（`CommitWorkspace`）を描く。
 */
function RepositoryPanel({
  entry,
  jumpTo,
  onCheckoutCommit,
  onCheckoutRef,
  onMergeRef,
  onNotice,
}: {
  entry: RepositoryEntry | null;
  jumpTo: { sha: string; nonce: number } | null;
  /** グラフ行の右クリックから checkout の確認を出す（T-18）。 */
  onCheckoutCommit: (sha: string) => void;
  onCheckoutRef: (subject: CheckoutSubject, choices: CheckoutChoice[]) => void;
  onMergeRef: (rev: string, revLabel: string, revSha: string, branch: string | null) => void;
  onNotice: (message: string) => void;
}) {
  const snapshot = useSnapshot();
  const settings = useSettings();

  if (entry === null) {
    return <p className="app__loading">{ja.repositories.empty}</p>;
  }

  const data = snapshot.data;
  const layout = snapshot.layout;
  const ready =
    snapshot.repositoryId === entry.id &&
    data !== null &&
    layout !== null &&
    data.commits.length > 0;

  if (!ready || data === null || layout === null) {
    const probe = entry.probe;
    return (
      <div className="ready">
        <div className="ready__card">
          <h1 className="ready__heading">{entry.name}</h1>
          <dl className="ready__facts">
            <dt>{ja.repositories.path}</dt>
            <dd>{entry.path}</dd>
            <dt>{ja.repositories.head}</dt>
            <dd>{describeHead(probe)}</dd>
          </dl>
          {probe?.indexLockPresent === true && (
            <p className="ready__note">{ja.repositories.indexLockDetail}</p>
          )}
        </div>

        <HistoryCard entry={entry} snapshot={snapshot} />
      </div>
    );
  }

  return (
    <CommitWorkspace
      entry={entry}
      data={data}
      layout={layout}
      order={snapshot.order}
      ui={settings.settings.ui}
      jumpTo={jumpTo}
      onCheckoutCommit={onCheckoutCommit}
      onCheckoutRef={onCheckoutRef}
      onMergeRef={onMergeRef}
      onNotice={onNotice}
    />
  );
}

/**
 * 3 ペインの中身（docs/DESIGN.md §6.1）。
 *
 * **左からグラフ ＋ 差分本体（上下分割）／ コミット詳細と変更ファイル一覧（右列）。**
 * 詳細と一覧を差分の上に積んでいたときは、差分本体に数行しか残らなかった。
 *
 * 取得は `useCommitFiles` で 1 回だけ行い、右列と差分本体の両方へ配る。
 * **フックを呼ぶのでリポジトリの読み込みが終わってから描くこと**（呼び出し側で分岐済み）。
 */
function CommitWorkspace({
  entry,
  data,
  layout,
  order,
  ui,
  jumpTo,
  onCheckoutCommit,
  onCheckoutRef,
  onMergeRef,
  onNotice,
}: {
  entry: RepositoryEntry;
  data: NonNullable<ReturnType<typeof useSnapshot>["data"]>;
  layout: NonNullable<ReturnType<typeof useSnapshot>["layout"]>;
  order: ReturnType<typeof useSnapshot>["order"];
  /** 差分の表示設定もここから配る（`settings.json` の `ui`）。 */
  ui: UiSettings;
  jumpTo: { sha: string; nonce: number } | null;
  onCheckoutCommit: (sha: string) => void;
  /** ref チップの右クリックから（T-18）。**ref ツリーと同じ翻訳を通す。** */
  onCheckoutRef: (subject: CheckoutSubject, choices: CheckoutChoice[]) => void;
  onMergeRef: (rev: string, revLabel: string, revSha: string, branch: string | null) => void;
  onNotice: (message: string) => void;
}) {
  const { state: uiState } = useUiState();

  /**
   * コミットメッセージ**全文**をコピーする。
   *
   * 一覧が持っているのは `subject`（要約 1 行）だけなので、git に聞き直す。
   * `subject` + `body` から組み立てると、**要約が複数行のコミットで改行が潰れる**。
   */
  const copyMessage = async (sha: string) => {
    try {
      const message = await loadCommitMessage(entry.id, sha);
      await navigator.clipboard.writeText(message);
      onNotice(ja.commits.copiedMessage(message.split("\n").length));
    } catch {
      onNotice(ja.commits.copyFailed);
    }
  };
  const perRepository = uiState.perRepository[entry.id] ?? DEFAULT_REPOSITORY_UI_STATE;

  // 遷移そのものは純関数（`lib/compareSelection.ts`）。ここは保存するだけ。
  const select = (sha: string, compare: boolean) => {
    setViewingWorking(false);
    updateRepositoryUiState(entry.id, (current) => ({
      ...current,
      ...selectCommit(current, sha, compare),
    }));
  };

  const clear = () => {
    updateRepositoryUiState(entry.id, (current) => ({ ...current, ...clearCompare(current) }));
  };

  const swap = () => {
    updateRepositoryUiState(entry.id, (current) => ({ ...current, ...swapEnds(current) }));
  };
  const setColumns = (columns: ColumnWidths) => {
    updateRepositoryUiState(entry.id, (current) => ({ ...current, columnWidths: columns }));
  };
  const selectFile = useCallback(
    (path: string | null) => {
      updateRepositoryUiState(entry.id, (current) => ({ ...current, selectedFile: path }));
    },
    [entry.id],
  );

  /**
   * マージベース起点で比べるか。**この比較かぎりの判断なので残さない**（§10.3）。
   * 比較の相手が変われば既定（2 点間差分）へ戻す。
   */
  const [symmetric, setSymmetric] = useState(false);
  const compareFrom = perRepository.compareCommit;
  useEffect(() => {
    setSymmetric(false);
  }, [compareFrom, entry.id]);

  const commitBySha = useMemo(() => {
    const map = new Map<string, CommitMeta>();
    for (const commit of data.commits) map.set(commit.sha, commit);
    return map;
  }, [data.commits]);

  const to = perRepository.selectedCommit;
  const scope: DiffScope | null =
    to === null
      ? null
      : compareFrom === null
        ? { kind: "commit", sha: to }
        : { kind: "compare", from: compareFrom, to, symmetric };

  /**
   * 作業ツリー（docs/DESIGN.md §7.5）。**選択中のコミットに関わらず常に取る** —
   * 擬似行を出すかどうかの判断に要るため。
   */
  const working = useWorkingTree(entry.id);
  const workingList = useMemo(() => workingEntries(working.tree), [working.tree]);

  /**
   * 作業ツリーを見ているか。**永続化しない** — 次に開いたときにはクリーンかもしれない。
   */
  const [viewingWorking, setViewingWorking] = useState(false);
  const [workingSelection, setWorkingSelection] = useState<WorkingSelection | null>(null);

  // クリーンになったら擬似行ごと消えるので、見ていたなら戻す。
  useEffect(() => {
    if (isClean(working.tree)) setViewingWorking(false);
  }, [working.tree]);

  // 外部で `git add` されると、選んでいた行がセクションごと消えることがある。
  useEffect(() => {
    if (workingList.length === 0) {
      setWorkingSelection(null);
      return;
    }
    setWorkingSelection((current) =>
      stillListed(workingList, current) ? current : workingList[0],
    );
  }, [workingList]);

  const files = useCommitFiles({
    repositoryId: entry.id,
    // 作業ツリーを見ているあいだはコミットの一覧を取りに行かない。
    scope: viewingWorking ? null : scope,
    commits: data.commits,
    selectedFile: perRepository.selectedFile,
    onSelectFile: selectFile,
  });

  // 一覧のキーボード操作は作業ツリーでも同じ（`Alt+↑` / `Alt+↓` / `Enter`）。
  useFileNavigation({
    keys: viewingWorking ? workingList.map(entryKey) : [],
    selected: workingSelection === null ? null : entryKey(workingSelection),
    onSelect: (key) => setWorkingSelection(parseKey(key)),
    bodyRef: files.bodyRef,
  });

  const workingEntry =
    workingSelection === null
      ? null
      : (workingList.find((item) => entryKey(item) === entryKey(workingSelection)) ?? null);

  /** 差分の出どころ。**呼び出し側で決めて `DiffPane` へ渡す。** */
  const diffSource: DiffSource | null = viewingWorking
    ? workingEntry === null || workingEntry.change === null
      ? null
      : { kind: "workingTree", staged: workingEntry.section === "staged" }
    : files.range === null
      ? null
      : rangeSource(files.range);

  const diffChange = viewingWorking
    ? (workingEntry?.change ?? null)
    : (files.changes.find((change) => change.path === perRepository.selectedFile) ?? null);

  return (
    <SplitPane
      direction="row"
      unit="px"
      anchor="second"
      size={uiState.paneRatios.commitInfoWidth}
      min={COMMIT_INFO_MIN}
      max={COMMIT_INFO_MAX}
      onSizeChange={(width) =>
        updateUiState((current) => ({
          ...current,
          paneRatios: { ...current.paneRatios, commitInfoWidth: width },
        }))
      }
      first={
        <SplitPane
          direction="column"
          unit="ratio"
          size={uiState.paneRatios.graphDiffSplit}
          min={0.15}
          max={0.85}
          onSizeChange={(ratio) =>
            updateUiState((current) => ({
              ...current,
              paneRatios: { ...current.paneRatios, graphDiffSplit: ratio },
            }))
          }
          first={
            <CommitList
              commits={data.commits}
              layout={layout}
              refs={data.refs}
              head={data.head}
              columns={perRepository.columnWidths}
              dateFormat={ui.dateFormat}
              selectedSha={viewingWorking ? null : perRepository.selectedCommit}
              compareSha={compareFrom}
              worktree={
                isClean(working.tree)
                  ? null
                  : {
                      summary: summarize(working.tree),
                      selected: viewingWorking,
                      onSelect: () => setViewingWorking(true),
                    }
              }
              jumpTo={jumpTo}
              order={order}
              onSelect={select}
              onCheckoutCommit={onCheckoutCommit}
              onCopyMessage={(sha) => void copyMessage(sha)}
              onCheckoutRef={(entry) => askCheckoutRef(entry, data.refs, onCheckoutRef)}
              onMergeRef={(entry) => askMergeRef(entry, data.head.branch, onMergeRef)}
              onNotice={onNotice}
              onColumnsChange={setColumns}
              onOrderChange={(next) => void snapshots.setOrder(next)}
            />
          }
          second={
            <DiffPane
              repositoryId={entry.id}
              source={diffSource}
              change={diffChange}
              untrackedPath={
                workingEntry?.section === "untracked" && viewingWorking
                  ? workingEntry.path
                  : null
              }
              conflictPath={
                workingEntry?.section === "unmerged" && viewingWorking
                  ? workingEntry.path
                  : null
              }
              bodyRef={files.bodyRef}
              ui={ui}
              onUiChange={(change) =>
                void updateSettings((current) => ({
                  ...current,
                  ui: { ...current.ui, ...change },
                }))
              }
            />
          }
        />
      }
      second={
        viewingWorking ? (
          working.tree === null ? (
            <div className="cinfo cinfo--empty">
              <p>{working.error ?? ja.diff.loading}</p>
            </div>
          ) : (
            <div className="cinfo">
              <WorkingTreeFiles
                tree={working.tree}
                selected={workingSelection}
                onSelect={setWorkingSelection}
                onReload={working.reload}
              />
            </div>
          )
        ) : (
        <CommitInfo
          sha={to}
          compare={
            compareFrom === null
              ? null
              : {
                  from: compareFrom,
                  to: to ?? compareFrom,
                  symmetric,
                  commitBySha,
                  onSymmetricChange: setSymmetric,
                  onSwap: swap,
                  onClear: clear,
                }
          }
          files={files}
          selectedFile={perRepository.selectedFile}
          onSelectFile={selectFile}
          onNotice={onNotice}
        />
        )
      }
    />
  );
}

/**
 * 一括取得した履歴の要約。グラフが入るまでの繋ぎであり、
 * 「何件を何 ms で読めたか」を確かめるための場所でもある。
 */
function HistoryCard({
  entry,
  snapshot,
}: {
  entry: RepositoryEntry;
  snapshot: ReturnType<typeof useSnapshot>;
}) {
  // 別のリポジトリの読み込み結果を出さない。
  if (snapshot.repositoryId !== entry.id) return null;

  // 前回が大きすぎたリポジトリは、起動時や切替で黙って読みに行かない。
  // 148 万コミットで数十秒操作できなくなり、プロセスが落ちることもあった。
  if (snapshot.oversized !== null) {
    return (
      <div className="ready__card">
        <h2 className="ready__heading">{ja.snapshot.oversizedTitle}</h2>
        <p>{ja.snapshot.oversizedBody(snapshot.oversized)}</p>
        <p className="ready__note">{ja.snapshot.oversizedNote}</p>
        <button type="button" className="button" onClick={() => void snapshots.loadAnyway()}>
          {ja.snapshot.oversizedLoad}
        </button>
      </div>
    );
  }

  if (snapshot.loading) {
    const progress = snapshot.progress;
    // 短い読み込みでバーが一瞬光るのは邪魔なだけ。しばらくかかってから出す。
    if (progress === null || progress.elapsedMs < SLOW_LOAD_MS) {
      return (
        <div className="ready__card">
          <p className="app__loading">{ja.snapshot.loading}</p>
        </div>
      );
    }
    return (
      <div className="ready__card">
        <LoadProgress
          label={phaseLabel(progress.phase)}
          done={progress.commits}
          total={progress.estimatedTotal}
          elapsedMs={progress.elapsedMs}
        />
      </div>
    );
  }

  if (snapshot.error !== null) {
    return (
      <div className="ready__card">
        <h2 className="ready__heading">{ja.snapshot.failedTitle}</h2>
        <p className="ready__note">{snapshot.error}</p>
        <button type="button" className="button" onClick={() => void snapshots.reload()}>
          {ja.snapshot.reload}
        </button>
      </div>
    );
  }

  const data = snapshot.data;
  if (data === null) return null;

  const local = data.refs.filter((ref) => ref.kind === "localBranch").length;
  const remote = data.refs.filter((ref) => ref.kind === "remoteBranch").length;
  const tags = data.refs.filter((ref) => ref.kind === "tag").length;
  const outOfGraph = data.refs.filter((ref) => ref.outOfGraph).length;

  return (
    <div className="ready__card">
      <dl className="ready__facts">
        <dt>{ja.snapshot.commits}</dt>
        <dd>
          {ja.snapshot.count(data.commits.length)}
          {snapshot.elapsedMs !== null && (
            <span className="ready__aside">{ja.snapshot.elapsed(snapshot.elapsedMs)}</span>
          )}
        </dd>
        <dt>{ja.snapshot.branches}</dt>
        <dd>{ja.snapshot.branchCounts(local, remote)}</dd>
        <dt>{ja.snapshot.tags}</dt>
        <dd>{ja.snapshot.count(tags)}</dd>
        <dt>{ja.snapshot.defaultBranch}</dt>
        <dd>{data.defaultBranch ?? ja.snapshot.none}</dd>
      </dl>
      {data.commits.length === 0 && <p className="ready__note">{ja.snapshot.emptyRepository}</p>}
      {outOfGraph > 0 && <p className="ready__note">{ja.snapshot.outOfGraph(outOfGraph)}</p>}
    </div>
  );
}

function phaseLabel(phase: LoadPhase): string {
  switch (phase) {
    case "refs":
      return ja.snapshot.progressRefs;
    case "commits":
      return ja.snapshot.progressCommits;
    case "graph":
      return ja.snapshot.progressGraph;
    case "transfer":
      return ja.snapshot.progressTransfer;
  }
}

function describeHead(probe: RepositoryEntry["probe"]): string {
  if (probe === null) return ja.repositories.missing;
  if (!probe.isRepository) return probe.error ?? ja.repositories.notRepository;
  switch (probe.head?.kind) {
    case "branch":
      return `${probe.head.name} (${probe.head.sha.slice(0, 7)})`;
    case "detached":
      return `${ja.repositories.detached} (${probe.head.sha.slice(0, 7)})`;
    case "unborn":
      return `${probe.head.name} — ${ja.repositories.unborn}`;
    default:
      return "-";
  }
}
