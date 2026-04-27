import { CommonModule } from '@angular/common';
import { Component, HostListener, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JUZ_BOUNDARIES, QURAN_SOURCE, QURAN_VERSES, QuranVerse, SURAHS, SurahInfo } from './data/quran-data';

type ScopeMode = 'all' | 'juz' | 'surah' | 'ayah';
type AppScreen = 'reader' | 'range' | 'save' | 'history';
type ReaderPanel = 'jump' | 'range' | null;

interface ScopePreference {
  mode: ScopeMode;
  fromJuz: number;
  toJuz: number;
  fromSurah: number;
  toSurah: number;
  ayah: number;
}

interface ReadingHistory {
  id: string;
  name: string;
  startIndex: number;
  endIndex: number;
  createdAt: string;
}

interface VersePanel {
  id: string;
  surah: SurahInfo | undefined;
  juz: number;
  quarter: number;
  startsAtOpening: boolean;
  verses: QuranVerse[];
}

const DEFAULT_SCOPE: ScopePreference = {
  mode: 'all',
  fromJuz: 1,
  toJuz: 30,
  fromSurah: 1,
  toSurah: 114,
  ayah: 1,
};

const STORAGE_PREFERENCES_KEY = 'quran-scroll-preferences';
const STORAGE_HISTORY_KEY = 'quran-scroll-history';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  private readonly pageSize = 5;

  protected readonly source = QURAN_SOURCE;
  protected readonly surahs = SURAHS;
  protected readonly verses = QURAN_VERSES;
  protected readonly juzs = Array.from({ length: 30 }, (_, index) => index + 1);
  protected readonly currentScreen = signal<AppScreen>('reader');
  protected readonly menuOpen = signal(false);
  protected readonly histories = signal<ReadingHistory[]>([]);
  protected readonly scope = signal<ScopePreference>({ ...DEFAULT_SCOPE });
  protected readonly startIndex = signal(0);
  protected readonly visibleCount = signal(this.pageSize);
  protected readonly selectedVerseIndex = signal<number | null>(null);
  protected readonly selectedRangeStartIndex = signal(0);
  protected readonly selectedRangeEndIndex = signal(this.pageSize - 1);
  protected readonly saveMessage = signal('');
  protected readonly readerPanel = signal<ReaderPanel>(null);

  protected jumpForm = {
    surah: 1,
    ayah: 1,
  };

  protected historyName = '';
  private rangeEndPinned = false;
  private sessionStarted = false;
  private loadingPrevious = false;
  private readerScrollY = 0;

  protected readonly visibleVerses = computed(() => {
    const start = this.startIndex();
    return QURAN_VERSES.slice(start, Math.min(start + this.visibleCount(), QURAN_VERSES.length));
  });

  protected readonly versePanels = computed<VersePanel[]>(() => {
    const panels: VersePanel[] = [];

    for (const verse of this.visibleVerses()) {
      const previousPanel = panels.at(-1);
      const previousVerse = previousPanel?.verses.at(-1);
      const startsPanel =
        !previousPanel || !previousVerse || previousVerse.surah !== verse.surah || previousVerse.quarter !== verse.quarter;

      if (startsPanel) {
        panels.push({
          id: `${verse.surah}-${verse.ayah}-${verse.quarter}`,
          surah: this.findSurah(verse.surah),
          juz: verse.juz,
          quarter: verse.quarter,
          startsAtOpening: verse.index === this.startIndex(),
          verses: [verse],
        });
        continue;
      }

      previousPanel.verses.push(verse);
    }

    return panels;
  });

  protected readonly openingVerse = computed(() => QURAN_VERSES[this.startIndex()]);
  protected readonly latestVerse = computed(() => this.visibleVerses().at(-1) ?? this.openingVerse());
  protected readonly rangeStartVerse = computed(() => QURAN_VERSES[this.selectedRangeStartIndex()]);
  protected readonly rangeEndVerse = computed(() => QURAN_VERSES[this.selectedRangeEndIndex()]);

  protected readonly selectedSurah = computed(() => this.findSurah(this.scope().fromSurah));
  protected readonly maxAyahForSelectedSurah = computed(() => this.selectedSurah()?.ayahCount ?? 1);

  ngOnInit(): void {
    this.loadPreferencesAndHistory();
  }

  @HostListener('window:scroll')
  protected onScroll(): void {
    if (this.currentScreen() !== 'reader') {
      return;
    }

    const nearTop = window.scrollY < 300;
    if (nearTop) {
      this.loadPrevious(true);
    }

    const nearBottom = window.innerHeight + window.scrollY > document.body.offsetHeight - 900;
    if (nearBottom) {
      this.loadMore();
    }
  }

  protected submitAuth(): void {
    // no-op: auth removed
  }

  protected signInWithGoogleCredential(_credential: string): void {
    // no-op: auth removed
  }

  protected startGoogleRedirect(): void {
    // no-op: auth removed
  }

  protected logout(): void {
    // no-op: auth removed
  }

  protected updateScope<K extends keyof ScopePreference>(key: K, value: ScopePreference[K]): void {
    const next = { ...this.scope(), [key]: value };

    if (key === 'fromSurah' && next.toSurah < next.fromSurah) {
      next.toSurah = next.fromSurah;
    }

    if (key === 'fromJuz' && next.toJuz < next.fromJuz) {
      next.toJuz = next.fromJuz;
    }

    if (key === 'fromSurah') {
      next.ayah = Math.min(next.ayah, this.findSurah(next.fromSurah)?.ayahCount ?? 1);
    }

    this.scope.set(this.normalizeScope(next));
  }

  protected openRandomVerse(savePreference = false): void {
    const index = this.randomIndexForScope(this.scope());
    this.openAt(index);
    this.currentScreen.set('reader');
    this.closeMenu();

    if (savePreference) {
      this.savePreferences();
    }
  }

  protected loadMore(): void {
    const oldLatest = this.latestVerse();
    const remaining = QURAN_VERSES.length - this.startIndex() - this.visibleCount();
    if (remaining <= 0) {
      return;
    }

    this.visibleCount.set(this.visibleCount() + Math.min(this.pageSize, remaining));
    if (!this.rangeEndPinned && this.selectedRangeEndIndex() === oldLatest.index) {
      this.selectedRangeEndIndex.set(this.latestVerse().index);
    }
  }

  protected loadPrevious(preserveScroll = false): void {
    const currentStart = this.startIndex();
    if (currentStart <= 0 || this.loadingPrevious) {
      return;
    }

    this.loadingPrevious = true;
    const added = Math.min(this.pageSize, currentStart);
    const oldHeight = document.body.scrollHeight;

    this.startIndex.set(currentStart - added);
    this.visibleCount.set(this.visibleCount() + added);

    queueMicrotask(() => {
      if (preserveScroll) {
        window.scrollTo({ top: window.scrollY + document.body.scrollHeight - oldHeight, behavior: 'auto' });
      }
      this.loadingPrevious = false;
    });
  }

  protected updateJumpSurah(surah: number): void {
    this.jumpForm.surah = this.clamp(Number(surah) || 1, 1, 114);
    this.jumpForm.ayah = this.clamp(this.jumpForm.ayah, 1, this.maxAyahForJumpSurah());
  }

  protected updateJumpAyah(ayah: number): void {
    this.jumpForm.ayah = this.clamp(Number(ayah) || 1, 1, this.maxAyahForJumpSurah());
  }

  protected maxAyahForJumpSurah(): number {
    return this.findSurah(this.jumpForm.surah)?.ayahCount ?? 1;
  }

  protected goToJumpVerse(): void {
    this.openAt(this.indexForSurahAyah(this.jumpForm.surah, this.jumpForm.ayah));
    this.currentScreen.set('reader');
    this.readerPanel.set(null);
    this.closeMenu();
  }

  protected selectVerse(verse: QuranVerse): void {
    this.selectedVerseIndex.set(verse.index);
  }

  protected setRangeStartHere(verse: QuranVerse, event?: MouseEvent): void {
    event?.stopPropagation();
    this.selectedRangeStartIndex.set(verse.index);
    if (this.selectedRangeEndIndex() < verse.index) {
      this.selectedRangeEndIndex.set(verse.index);
      this.rangeEndPinned = true;
    }
    this.selectedVerseIndex.set(verse.index);
  }

  protected setRangeEndHere(verse: QuranVerse, event?: MouseEvent): void {
    event?.stopPropagation();
    if (verse.index < this.selectedRangeStartIndex()) {
      this.selectedRangeStartIndex.set(verse.index);
    }
    this.selectedRangeEndIndex.set(verse.index);
    this.rangeEndPinned = true;
    this.selectedVerseIndex.set(verse.index);
  }

  protected isRangeStart(verse: QuranVerse): boolean {
    return verse.index === this.selectedRangeStartIndex();
  }

  protected isRangeEnd(verse: QuranVerse): boolean {
    return verse.index === this.selectedRangeEndIndex();
  }

  protected isInsideSelectedRange(verse: QuranVerse): boolean {
    return verse.index >= this.selectedRangeStartIndex() && verse.index <= this.selectedRangeEndIndex();
  }

  protected rangeBoundarySurah(boundary: 'start' | 'end'): number {
    return this.rangeBoundaryVerse(boundary)?.surah ?? 1;
  }

  protected rangeBoundaryAyah(boundary: 'start' | 'end'): number {
    return this.rangeBoundaryVerse(boundary)?.ayah ?? 1;
  }

  protected maxAyahForBoundary(boundary: 'start' | 'end'): number {
    return this.findSurah(this.rangeBoundarySurah(boundary))?.ayahCount ?? 1;
  }

  protected updateRangeBoundary(boundary: 'start' | 'end', field: 'surah' | 'ayah', value: number): void {
    const current = this.rangeBoundaryVerse(boundary);
    const surah = field === 'surah' ? Number(value) : current?.surah ?? 1;
    const ayah = field === 'ayah' ? Number(value) : current?.ayah ?? 1;
    const nextIndex = this.indexForSurahAyah(surah, ayah);

    if (boundary === 'start') {
      this.selectedRangeStartIndex.set(nextIndex);
      if (this.selectedRangeEndIndex() < nextIndex) {
        this.selectedRangeEndIndex.set(nextIndex);
      }
      return;
    }

    if (nextIndex < this.selectedRangeStartIndex()) {
      this.selectedRangeStartIndex.set(nextIndex);
    }
    this.selectedRangeEndIndex.set(nextIndex);
    this.rangeEndPinned = true;
  }

  protected saveCurrentReading(): void {
    const opening = this.rangeStartVerse();
    const latest = this.rangeEndVerse();
    const fallbackName = `${this.referenceFor(opening)} إلى ${this.referenceFor(latest)}`;
    const name = this.historyName.trim() || fallbackName;

    const entry: ReadingHistory = {
      id: crypto.randomUUID(),
      name,
      startIndex: opening.index,
      endIndex: latest.index,
      createdAt: new Date().toISOString(),
    };

    const updated = [entry, ...this.histories()];
    this.histories.set(updated);
    localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(updated));
    this.historyName = '';
    this.saveMessage.set('تم حفظ الجلسة.');
    this.readerPanel.set(null);
    this.showReader();
  }

  protected resumeHistory(history: ReadingHistory): void {
    this.openAt(history.startIndex, history.endIndex - history.startIndex + 1);
    this.rangeEndPinned = true;
    this.currentScreen.set('reader');
    this.closeMenu();
  }

  protected deleteHistory(history: ReadingHistory, event: MouseEvent): void {
    event.stopPropagation();
    const updated = this.histories().filter((item) => item.id !== history.id);
    this.histories.set(updated);
    localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(updated));
  }

  protected referenceFor(verse: QuranVerse | undefined): string {
    if (!verse) {
      return '';
    }

    const surah = this.findSurah(verse.surah);
    return `${surah?.name ?? verse.surah} ${verse.ayah}`;
  }

  protected surahFor(verse: QuranVerse): SurahInfo | undefined {
    return this.findSurah(verse.surah);
  }

  protected trackVerse(_: number, verse: QuranVerse): number {
    return verse.index;
  }

  protected trackPanel(_: number, panel: VersePanel): string {
    return panel.id;
  }

  protected setAuthMode(_mode: 'login' | 'register'): void {
    // no-op: auth removed
  }

  protected openScreen(screen: AppScreen): void {
    if (this.currentScreen() === 'reader' && screen !== 'reader') {
      this.readerScrollY = window.scrollY;
    }

    this.currentScreen.set(screen);
    this.closeMenu();

    if (screen === 'reader') {
      this.restoreReaderScroll();
    } else {
      queueMicrotask(() => window.scrollTo({ top: 0, behavior: 'auto' }));
    }
  }

  protected backToReader(): void {
    this.showReader();
    this.closeMenu();
  }

  protected toggleReaderPanel(panel: Exclude<ReaderPanel, null>): void {
    this.readerPanel.set(this.readerPanel() === panel ? null : panel);
  }

  protected toggleMenu(): void {
    this.menuOpen.set(!this.menuOpen());
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  private loadPreferencesAndHistory(): void {
    const rawPrefs = localStorage.getItem(STORAGE_PREFERENCES_KEY);
    if (rawPrefs) {
      try {
        this.scope.set(this.normalizeScope(JSON.parse(rawPrefs)));
      } catch { }
    }

    if (!this.sessionStarted) {
      this.openRandomVerse();
    }

    const rawHistory = localStorage.getItem(STORAGE_HISTORY_KEY);
    if (rawHistory) {
      try {
        this.histories.set(JSON.parse(rawHistory));
      } catch { }
    }
  }

  private savePreferences(): void {
    localStorage.setItem(STORAGE_PREFERENCES_KEY, JSON.stringify(this.scope()));
  }

  private openAt(index: number, count = this.pageSize): void {
    const normalizedIndex = Math.max(0, Math.min(index, QURAN_VERSES.length - 1));
    const normalizedCount = Math.max(this.pageSize, count);
    const normalizedEndIndex = Math.min(normalizedIndex + normalizedCount - 1, QURAN_VERSES.length - 1);

    this.sessionStarted = true;
    this.readerScrollY = 0;
    this.startIndex.set(normalizedIndex);
    this.visibleCount.set(normalizedCount);
    this.selectedRangeStartIndex.set(normalizedIndex);
    this.selectedRangeEndIndex.set(normalizedEndIndex);
    this.selectedVerseIndex.set(null);
    this.rangeEndPinned = false;
    this.syncJumpFormToVerse(QURAN_VERSES[normalizedIndex]);
    queueMicrotask(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  private showReader(): void {
    this.currentScreen.set('reader');
    this.restoreReaderScroll();
  }

  private restoreReaderScroll(): void {
    queueMicrotask(() => {
      const rangeStart = document.querySelector('.range-start');
      if (rangeStart) {
        rangeStart.scrollIntoView({ behavior: 'auto', block: 'start' });
      } else {
        window.scrollTo({ top: this.readerScrollY, behavior: 'auto' });
      }
    });
  }

  private rangeBoundaryVerse(boundary: 'start' | 'end'): QuranVerse | undefined {
    return boundary === 'start' ? this.rangeStartVerse() : this.rangeEndVerse();
  }

  private indexForSurahAyah(surahNumber: number, ayahNumber: number): number {
    const surah = this.findSurah(this.clamp(Number(surahNumber) || 1, 1, 114))!;
    const ayah = this.clamp(Number(ayahNumber) || 1, 1, surah.ayahCount);
    return surah.startIndex + ayah - 1;
  }

  private syncJumpFormToVerse(verse: QuranVerse): void {
    this.jumpForm.surah = verse.surah;
    this.jumpForm.ayah = verse.ayah;
  }

  private randomIndexForScope(scope: ScopePreference): number {
    const normalized = this.normalizeScope(scope);
    let fromIndex = 0;
    let toIndex = QURAN_VERSES.length - 1;

    if (normalized.mode === 'juz') {
      const from = JUZ_BOUNDARIES[normalized.fromJuz - 1];
      const to = JUZ_BOUNDARIES[normalized.toJuz - 1];
      fromIndex = from.fromIndex;
      toIndex = to.toIndex;
    }

    if (normalized.mode === 'surah') {
      const from = this.findSurah(normalized.fromSurah)!;
      const to = this.findSurah(normalized.toSurah)!;
      fromIndex = from.startIndex;
      toIndex = to.startIndex + to.ayahCount - 1;
    }

    if (normalized.mode === 'ayah') {
      const surah = this.findSurah(normalized.fromSurah)!;
      return surah.startIndex + Math.min(normalized.ayah, surah.ayahCount) - 1;
    }

    return fromIndex + Math.floor(Math.random() * (toIndex - fromIndex + 1));
  }

  private normalizeScope(scope: ScopePreference): ScopePreference {
    const fromJuz = this.clamp(Number(scope.fromJuz) || 1, 1, 30);
    const toJuz = this.clamp(Number(scope.toJuz) || fromJuz, fromJuz, 30);
    const fromSurah = this.clamp(Number(scope.fromSurah) || 1, 1, 114);
    const toSurah = this.clamp(Number(scope.toSurah) || fromSurah, fromSurah, 114);
    const maxAyah = this.findSurah(fromSurah)?.ayahCount ?? 1;

    return {
      mode: scope.mode || 'all',
      fromJuz,
      toJuz,
      fromSurah,
      toSurah,
      ayah: this.clamp(Number(scope.ayah) || 1, 1, maxAyah),
    };
  }

  private findSurah(number: number): SurahInfo | undefined {
    return SURAHS[number - 1];
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
