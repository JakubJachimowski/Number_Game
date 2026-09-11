import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import {
  Animated,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Canvas,
  Rect,
  Line,
  Text as SkiaText,
  Group,
  matchFont,
  vec,
} from '@shopify/react-native-skia';

const COLS = 9;
const ADD_LIMIT = 4;
const HINT_LIMIT = 5;

const STRIKE_MS = 200; // how long the connecting line takes to fade in over the pair
const SHRINK_MS = 260; // how long the numbers (and the line) then take to shrink and fade away
const WRONG_COLOR_MS = 90; // how fast the wrong selection flashes red
const WRONG_STEP_MS = 42; // duration of each shake step
const LINE_THICKNESS = 5; // thickness of the single line that strikes through a matched pair

// Two manually-selectable themes (no longer tied to the system color scheme).
const THEMES = {
  dark: {
    paper: '#111a12',
    paper2: '#0d150e',
    rule: '#25392a',
    ruleStrong: '#33502f',
    margin: '#8a3f37',
    ink: '#eaf1e2',
    inkSoft: '#a9bb9f',
    accentRed: '#d9695a',
    accentRedDeep: '#e58a7c',
    accentGold: '#e0b45a',
    accentScore: '#5fb0ff',
    accentLine: '#e0b45a',
    accentSelect: '#e0b45a',
    selectText: '#111a12',
    card: '#152018',
    cardEdge: '#28381f',
  },
  light: {
    // As close to pure white as possible for both the background and the tiles;
    // black digits/cards, blue score, light-blue strike-through & selection.
    paper: '#ffffff',
    paper2: '#ffffff',
    rule: '#e2e3e5',
    ruleStrong: '#c3c5c9',
    margin: '#1857b8',
    ink: '#111111',
    inkSoft: '#55585c',
    accentRed: '#b23b2e',
    accentRedDeep: '#8f2c22',
    accentGold: '#b3811f',
    accentScore: '#1857b8',
    accentLine: '#5cb6f5',
    accentSelect: '#8fd0f5',
    selectText: '#111111',
    card: '#ffffff',
    cardEdge: '#dcdde0',
  },
};

const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' });
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace', default: 'monospace' });

// Time-seeded id generator: immune to Metro Fast Refresh resetting a module-scope
// counter back to 1 while React state (holding old ids) survives the refresh.
let idSeq = 0;
function freshId() {
  idSeq += 1;
  return `${Date.now().toString(36)}-${idSeq}`;
}

// One random valid pair (equal values, or summing to 10).
function freshPair() {
  const v1 = 1 + Math.floor(Math.random() * 9);
  const v2 = Math.random() < 0.5 ? v1 : 10 - v1;
  return [
    { id: freshId(), value: v1, cleared: false },
    { id: freshId(), value: v2, cleared: false },
  ];
}

function randomRow() {
  const row = [];
  for (let i = 0; i < COLS; i++) {
    row.push({ id: freshId(), value: 1 + Math.floor(Math.random() * 9), cleared: false });
  }
  return row;
}

function makeInitialGrid() {
  const grid = [];
  for (let r = 0; r < 5; r++) grid.push(randomRow());
  return grid;
}

function flattenGrid(grid) {
  const out = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < COLS; c++) {
      out.push({ r, c, cell: grid[r][c] });
    }
  }
  return out;
}

function remainingCount(grid) {
  let n = 0;
  for (const row of grid) for (const cell of row) if (!cell.cleared) n++;
  return n;
}

function isMatchValue(a, b) {
  return a.value === b.value || a.value + b.value === 10;
}

function isAdjacent2D(r1, c1, r2, c2) {
  return Math.abs(r1 - r2) <= 1 && Math.abs(c1 - c2) <= 1 && !(r1 === r2 && c1 === c2);
}

// True when (r1,c1) and (r2,c2) sit on the same row, column, or diagonal and every
// cell strictly between them on that line is already cleared (no obstruction).
function lineOfSightConnect(flat, r1, c1, r2, c2) {
  const dr = Math.sign(r2 - r1);
  const dc = Math.sign(c2 - c1);
  const sameRow = r1 === r2;
  const sameCol = c1 === c2;
  const sameDiagonal = Math.abs(r1 - r2) === Math.abs(c1 - c2) && r1 !== r2;
  if (!sameRow && !sameCol && !sameDiagonal) return false;

  let r = r1 + dr;
  let c = c1 + dc;
  while (r !== r2 || c !== c2) {
    const cell = flat[r * COLS + c];
    if (!cell || !cell.cell.cleared) return false;
    r += dr;
    c += dc;
  }
  return true;
}

function canConnect(flat, idxA, idxB) {
  const a = flat[idxA];
  const b = flat[idxB];
  if (a.cell.cleared || b.cell.cleared) return false;
  if (!isMatchValue(a.cell, b.cell)) return false;
  if (isAdjacent2D(a.r, a.c, b.r, b.c)) return true;

  // Classic rule: connected if every number between them in reading order
  // (left to right, wrapping line to line) has already been cleared.
  const lo = Math.min(idxA, idxB);
  const hi = Math.max(idxA, idxB);
  let readingOrderClear = true;
  for (let i = lo + 1; i < hi; i++) {
    if (!flat[i].cell.cleared) {
      readingOrderClear = false;
      break;
    }
  }
  if (readingOrderClear) return true;

  // Extra rule: also connect along a clear straight line - horizontal,
  // vertical, or diagonal - even if it doesn't follow reading order.
  return lineOfSightConnect(flat, a.r, a.c, b.r, b.c);
}

function findAnyMatch(grid) {
  const flat = flattenGrid(grid);
  const open = [];
  flat.forEach((f, i) => {
    if (!f.cell.cleared) open.push(i);
  });
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      if (canConnect(flat, open[i], open[j])) return [open[i], open[j]];
    }
  }
  return null;
}

function pruneEmptyRows(grid) {
  const kept = grid.filter((row) => row.some((cell) => !cell.cleared));
  return kept.length === 0 ? [] : kept;
}

// Small hex-color lerp used to animate the "wrong match" flash on the Skia canvas
// (Skia's Rect wants a plain color string per frame, not an Animated interpolation).
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function lerpColor(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

// Pixel center of cell (r,c) inside the board, given the current cell size and the
// padding+border offset before the first cell.
function cellCenter(r, c, cellSize, offset) {
  return {
    x: offset + c * cellSize + cellSize / 2,
    y: offset + r * cellSize + cellSize / 2,
  };
}

// Builds the segment list for the single line that strikes through a matched pair.
// Adjacent/diagonal/straight-line matches get one segment; a reading-order match
// that wraps across rows gets a snaking multi-segment path along the row edges, so
// the line visibly runs through every (already faint) tile in between.
function buildConnectorSegments(a, b, straight, cellSize, offset, cols) {
  const centerOf = (r, c) => cellCenter(r, c, cellSize, offset);

  if (straight) {
    const p1 = centerOf(a.r, a.c);
    const p2 = centerOf(b.r, b.c);
    return [{ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }];
  }

  const idxA = a.r * cols + a.c;
  const idxB = b.r * cols + b.c;
  const lo = idxA < idxB ? a : b;
  const hi = idxA < idxB ? b : a;

  if (lo.r === hi.r) {
    const p1 = centerOf(lo.r, lo.c);
    const p2 = centerOf(hi.r, hi.c);
    return [{ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }];
  }

  const segments = [];
  const firstRowEnd = centerOf(lo.r, cols - 1);
  const firstRowStart = centerOf(lo.r, lo.c);
  segments.push({ x1: firstRowStart.x, y1: firstRowStart.y, x2: firstRowEnd.x, y2: firstRowEnd.y });

  let prevEdge = firstRowEnd;
  for (let rr = lo.r + 1; rr < hi.r; rr++) {
    const rowStart = centerOf(rr, 0);
    const rowEnd = centerOf(rr, cols - 1);
    segments.push({ x1: prevEdge.x, y1: prevEdge.y, x2: rowStart.x, y2: rowStart.y });
    segments.push({ x1: rowStart.x, y1: rowStart.y, x2: rowEnd.x, y2: rowEnd.y });
    prevEdge = rowEnd;
  }

  const lastRowStart = centerOf(hi.r, 0);
  const lastRowEnd = centerOf(hi.r, hi.c);
  segments.push({ x1: prevEdge.x, y1: prevEdge.y, x2: lastRowStart.x, y2: lastRowStart.y });
  segments.push({ x1: lastRowStart.x, y1: lastRowStart.y, x2: lastRowEnd.x, y2: lastRowEnd.y });

  return segments;
}

// Static mini illustrations for the "how to match" info panel.
const MATCH_EXAMPLES = [
  {
    label: 'Po skosie',
    rows: [
      [{ value: 4, hi: true }, { value: 5, hi: false }],
      [{ value: 3, hi: false }, { value: 4, hi: true }],
    ],
  },
  {
    label: 'Poziomo',
    rows: [
      [{ value: 9, hi: true }, { value: 1, hi: true }],
      [{ value: 5, hi: false }, { value: 3, hi: false }],
    ],
  },
  {
    label: 'Pionowo',
    rows: [
      [{ value: 5, hi: false }, { value: 7, hi: true }],
      [{ value: 3, hi: false }, { value: 7, hi: true }],
    ],
  },
  {
    label: 'Linia do linii',
    rows: [
      [{ value: 5, hi: false }, { value: 8, hi: true }],
      [{ value: 2, hi: true }, { value: 3, hi: false }],
    ],
  },
];

function MiniMatchExample({ colors, styles, rows, label }) {
  return (
    <View style={styles.miniExample}>
      <View style={styles.miniGrid}>
        {rows.map((row, ri) => (
          <View key={ri} style={styles.miniRow}>
            {row.map((cell, ci) => (
              <View
                key={ci}
                style={[styles.miniCell, cell.hi && { backgroundColor: colors.accentSelect }]}
              >
                <Text
                  style={[
                    styles.miniCellText,
                    { color: cell.hi ? colors.selectText : colors.inkSoft },
                  ]}
                >
                  {cell.value}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
      <Text style={styles.miniLabel}>{label}</Text>
    </View>
  );
}

function GameScreen() {
  const [themeName, setThemeName] = useState('dark');
  const colors = THEMES[themeName];
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const outerPad = 20;
  const boardBorder = 3;
  const boardInnerPad = 4;
  // Keep the game area off the screen edges by 10% of the screen width on each side.
  const boardSideInset = Math.round(width * 0.1);
  const cellSize = Math.floor(
    (Math.min(width, 640) - boardSideInset * 2 - boardBorder * 2 - boardInnerPad * 2) / COLS
  );

  const [grid, setGrid] = useState(makeInitialGrid);
  const [selected, setSelected] = useState(null);
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [won, setWon] = useState(false);
  const [toast, setToast] = useState('');
  const [hintPair, setHintPair] = useState(null);
  const [locked, setLocked] = useState(false);
  const [addCount, setAddCount] = useState(0);
  const [hintCount, setHintCount] = useState(0);
  const [wrongCellId, setWrongCellId] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [matchLine, setMatchLine] = useState(null); // { segments } while a match animates
  const toastTimer = useRef(null);
  const hintTimer = useRef(null);
  const lockedRef = useRef(false);

  const wrongColor = useRef(new Animated.Value(0)).current; // 0 = gold, 1 = red
  const wrongShake = useRef(new Animated.Value(0)).current; // -1..1
  const lineOpacity = useRef(new Animated.Value(0)).current; // fade for the single connecting line

  // The board is drawn on a Skia canvas now, which wants plain numbers per frame
  // rather than Animated interpolations - these mirror the three shared Animated
  // values into state so the canvas re-draws as they change.
  const [wrongColorNum, setWrongColorNum] = useState(0);
  const [wrongShakeNum, setWrongShakeNum] = useState(0);
  const [lineOpacityNum, setLineOpacityNum] = useState(0);

  useEffect(() => {
    const idColor = wrongColor.addListener(({ value }) => setWrongColorNum(value));
    const idShake = wrongShake.addListener(({ value }) => setWrongShakeNum(value));
    const idLine = lineOpacity.addListener(({ value }) => setLineOpacityNum(value));
    return () => {
      wrongColor.removeListener(idColor);
      wrongShake.removeListener(idShake);
      lineOpacity.removeListener(idLine);
    };
  }, [wrongColor, wrongShake, lineOpacity]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 1900);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    []
  );

  useEffect(() => {
    setBestScore((b) => (score > b ? score : b));
  }, [score]);

  const toggleTheme = useCallback(() => {
    setThemeName((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const onOpenSettings = useCallback(() => {
    showToast('Ustawienia — wkrótce.');
  }, [showToast]);

  const toggleInfo = useCallback(() => {
    setInfoOpen((v) => !v);
  }, []);

  const newGame = useCallback(() => {
    if (lockedRef.current) return;
    setGrid(makeInitialGrid());
    setSelected(null);
    setScore(0);
    setWon(false);
    setHintPair(null);
    setAddCount(0);
    setHintCount(0);
    setWrongCellId(null);
  }, []);

  const remaining = remainingCount(grid);

  const commitMatch = useCallback(
    (a, b, distant) => {
      setGrid((currentGrid) => {
        const nextGrid = currentGrid.map((row) => row.map((cell) => ({ ...cell })));
        if (nextGrid[a.r] && nextGrid[a.r][a.c]) nextGrid[a.r][a.c].cleared = true;
        if (nextGrid[b.r] && nextGrid[b.r][b.c]) nextGrid[b.r][b.c].cleared = true;

        let gained = distant ? 4 : 2;
        [a.r, b.r].forEach((r) => {
          if (nextGrid[r] && nextGrid[r].length && nextGrid[r].every((c) => c.cleared)) {
            gained += 10;
          }
        });

        const prunedGrid = pruneEmptyRows(nextGrid);
        const left = remainingCount(prunedGrid);

        if (left === 0) {
          setScore((s) => s + gained + 150);
          setWon(true);
        } else {
          setScore((s) => s + gained);
          if (!findAnyMatch(prunedGrid)) {
            showToast('Brak ruchów — spróbuj "Dołóż pozostałe liczby".');
          }
        }

        return prunedGrid;
      });

      lockedRef.current = false;
      setLocked(false);
    },
    [showToast]
  );

  const animateMatch = useCallback(
    (a, b, distant, straight) => {
      lockedRef.current = true;
      setLocked(true);

      // Segments are in the Skia canvas's own coordinate space, which starts at
      // (0,0) right where the first cell begins (the board View's own padding
      // already accounts for the border/inner-padding inset).
      const segments = buildConnectorSegments(a, b, straight, cellSize, 0, COLS);
      setMatchLine({ segments });
      lineOpacity.setValue(0);

      Animated.timing(lineOpacity, {
        toValue: 1,
        duration: STRIKE_MS,
        useNativeDriver: false,
      }).start(() => {
        commitMatch(a, b, distant);
        setMatchLine(null);
      });
    },
    [commitMatch, cellSize, lineOpacity]
  );

  const animateWrong = useCallback((cellId) => {
    lockedRef.current = true;
    setLocked(true);
    setWrongCellId(cellId);
    wrongColor.setValue(0);
    wrongShake.setValue(0);

    Animated.sequence([
      Animated.timing(wrongColor, { toValue: 1, duration: WRONG_COLOR_MS, useNativeDriver: false }),
      Animated.parallel([
        Animated.sequence([
          Animated.timing(wrongShake, { toValue: 1, duration: WRONG_STEP_MS, useNativeDriver: false }),
          Animated.timing(wrongShake, { toValue: -1, duration: WRONG_STEP_MS, useNativeDriver: false }),
          Animated.timing(wrongShake, { toValue: 0.6, duration: WRONG_STEP_MS, useNativeDriver: false }),
          Animated.timing(wrongShake, { toValue: -0.6, duration: WRONG_STEP_MS, useNativeDriver: false }),
          Animated.timing(wrongShake, { toValue: 0, duration: WRONG_STEP_MS, useNativeDriver: false }),
        ]),
        Animated.timing(wrongColor, {
          toValue: 0,
          duration: WRONG_STEP_MS * 4,
          delay: WRONG_STEP_MS,
          useNativeDriver: false,
        }),
      ]),
    ]).start(() => {
      setWrongCellId(null);
      setSelected(null);
      lockedRef.current = false;
      setLocked(false);
    });
  }, [wrongColor, wrongShake]);

  const onCellPress = useCallback(
    (idx) => {
      if (won || lockedRef.current) return;
      const currentFlat = flattenGrid(grid);
      const target = currentFlat[idx];
      if (!target || target.cell.cleared) return;
      setHintPair(null);

      if (selected === null) {
        setSelected(idx);
        return;
      }
      if (selected === idx) {
        setSelected(null);
        return;
      }

      if (canConnect(currentFlat, selected, idx)) {
        const a = currentFlat[selected];
        const b = currentFlat[idx];
        const distant = !isAdjacent2D(a.r, a.c, b.r, b.c);
        // Straight = adjacent or a clear horizontal/vertical/diagonal line: one
        // segment is enough. Otherwise it's a reading-order match that wraps
        // across rows, so the line needs to snake along the row edges instead.
        const straight = !distant || lineOfSightConnect(currentFlat, a.r, a.c, b.r, b.c);
        setSelected(null);
        animateMatch(a, b, distant, straight);
      } else {
        const prevCellId = currentFlat[selected].cell.id;
        animateWrong(prevCellId);
      }
    },
    [grid, selected, won, animateMatch, animateWrong]
  );

  // The whole board is now one touch-catching View over a single Skia canvas
  // (see the render below), so a single handler converts a tap's pixel position
  // into a row/col and hands it to onCellPress - no more one press-handler per tile.
  const handleBoardTouch = useCallback(
    (evt) => {
      const { locationX, locationY } = evt.nativeEvent;
      const col = Math.floor(locationX / cellSize);
      const row = Math.floor(locationY / cellSize);
      if (row < 0 || row >= grid.length || col < 0 || col >= COLS) return;
      const cell = grid[row][col];
      if (!cell || cell.cleared) return;
      onCellPress(row * COLS + col);
    },
    [grid, cellSize, onCellPress]
  );

  const onAddRemaining = useCallback(() => {
    if (won || lockedRef.current) return;
    if (addCount >= ADD_LIMIT) {
      showToast(`Osiągnięto limit dokładania liczb (${ADD_LIMIT}/${ADD_LIMIT}).`);
      return;
    }
    const openCount = remainingCount(grid);
    if (openCount === 0) {
      showToast('Nie ma nic do dołożenia.');
      return;
    }
    // Generate fresh random valid pairs each time (never a copy of what's already
    // on the board), sized to the current open count so the board stays solvable -
    // but capped, so pressing this repeatedly without clearing anything can't make
    // the board double in size every time (45 -> 91 -> 183 -> 367 cells was the old,
    // unbounded behavior, which is what made things slow).
    const pairCount = Math.min(Math.ceil(openCount / 2), 25);
    const fresh = [];
    for (let i = 0; i < pairCount; i++) fresh.push(...freshPair());

    const newRows = [];
    for (let i = 0; i < fresh.length; i += COLS) {
      const slice = fresh.slice(i, i + COLS);
      while (slice.length < COLS) slice.push({ id: freshId(), value: 0, cleared: true });
      newRows.push(slice);
    }
    setGrid((g) => g.concat(newRows));
    setSelected(null);
    setAddCount((n) => n + 1);
    showToast(`Dołożono ${fresh.length} nowych liczb.`);
  }, [grid, won, addCount, showToast]);

  const onHint = useCallback(() => {
    if (won || lockedRef.current) return;
    if (hintCount >= HINT_LIMIT) {
      showToast(`Osiągnięto limit podpowiedzi (${HINT_LIMIT}/${HINT_LIMIT}).`);
      return;
    }
    const match = findAnyMatch(grid);
    if (match) {
      setSelected(null);
      setHintPair(match);
      setHintCount((n) => n + 1);
      if (hintTimer.current) clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setHintPair(null), 1900);
    } else {
      showToast('Brak pary na planszy — dołóż liczby.');
    }
  }, [grid, won, showToast, hintCount]);

  // Reserved empty space at the top/bottom (for future content, and so nothing
  // ever lands under Android's real status bar or nav/gesture bar). insets.top /
  // insets.bottom come straight from the system, so those zones are never guessed.
  const BUTTON_ROW_HEIGHT = 52; // icon button size + breathing room
  const baseTopPad = Math.round(height * 0.2 * 0.6); // top distance cut by 40%
  const baseBottomPad = Math.round(height * 0.2);
  const topPad = Math.max(baseTopPad, insets.top + BUTTON_ROW_HEIGHT);
  const bottomPad = Math.max(baseBottomPad, insets.bottom + 12);

  const styles = useMemo(
    () => makeStyles(colors, cellSize, outerPad, boardBorder, boardInnerPad),
    [colors, cellSize]
  );

  // Font used to draw the digits directly on the Skia canvas (see the board
  // render below). matchFont finds a system font by descriptor - no font file
  // needs to be bundled with the app.
  const cellFont = useMemo(
    () =>
      matchFont({
        fontFamily: MONO,
        fontSize: Math.round(cellSize * 0.62),
        fontWeight: 'bold',
      }),
    [cellSize]
  );
  // Board values are always a single digit (1-9), so precompute each digit's
  // rendered width once per font instead of measuring text on every cell/render.
  const digitWidths = useMemo(() => {
    const widths = {};
    for (let d = 0; d <= 9; d++) widths[d] = cellFont.getTextWidth(String(d));
    return widths;
  }, [cellFont]);

  const boardWidth = cellSize * COLS;
  const boardHeight = cellSize * grid.length;

  const addLimitReached = addCount >= ADD_LIMIT;
  const hintLimitReached = hintCount >= HINT_LIMIT;

  return (
    <View style={styles.safe}>
      <StatusBar style={themeName === 'dark' ? 'light' : 'dark'} />

      <View style={[styles.topBar, { height: topPad, paddingTop: insets.top + 8 }]}>
        <TouchableOpacity style={styles.iconButton} activeOpacity={0.7} onPress={toggleInfo}>
          <Text style={styles.iconButtonText}>ⓘ</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconButton} activeOpacity={0.7} onPress={toggleTheme}>
          <Text style={styles.iconButtonText}>{themeName === 'dark' ? '☀' : '🌙'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconButton} activeOpacity={0.7} onPress={onOpenSettings}>
          <Text style={styles.iconButtonText}>⚙</Text>
        </TouchableOpacity>
      </View>

      {infoOpen && (
        <>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setInfoOpen(false)}
          />
          <View style={[styles.infoPanel, { top: topPad }]}>
            <Text style={styles.infoTitle}>Te same liczby lub suma 10</Text>
            <View style={styles.infoRow}>
              {MATCH_EXAMPLES.map((ex) => (
                <MiniMatchExample
                  key={ex.label}
                  colors={colors}
                  styles={styles}
                  rows={ex.rows}
                  label={ex.label}
                />
              ))}
            </View>
          </View>
        </>
      )}

      <ScrollView style={styles.scrollFlex} contentContainerStyle={styles.scroll}>
        <View style={styles.sheet}>
          <View style={styles.totalsRow}>
            <View style={styles.totalBlockLeft}>
              <Text style={styles.totalLabelWhite}>Najlepszy wynik</Text>
              <Text style={styles.totalValueWhite}>{bestScore}</Text>
            </View>
            <View style={styles.totalsRowRight}>
              <View style={styles.totalBlock}>
                <Text style={styles.totalLabel}>Zostało</Text>
                <Text style={styles.totalValue}>{remaining}</Text>
              </View>
              <View style={styles.totalBlock}>
                <Text style={styles.totalLabel}>Wynik</Text>
                <Text style={[styles.totalValue, { color: colors.accentScore }]}>{score}</Text>
              </View>
            </View>
          </View>

          <View style={[styles.boardWrap, { marginHorizontal: boardSideInset - outerPad }]}>
            <View style={styles.board}>
              <View
                style={{ width: boardWidth, height: boardHeight }}
                onStartShouldSetResponder={() => true}
                onResponderRelease={handleBoardTouch}
              >
                <Canvas style={{ width: boardWidth, height: boardHeight }}>
                  {/* Grid lines - one pass across the whole board rather than a
                      bordered rect per cell. */}
                  {Array.from({ length: COLS + 1 }, (_, i) => (
                    <Line
                      key={`v${i}`}
                      p1={vec(i * cellSize, 0)}
                      p2={vec(i * cellSize, boardHeight)}
                      color={colors.rule}
                      strokeWidth={1}
                    />
                  ))}
                  {Array.from({ length: grid.length + 1 }, (_, j) => (
                    <Line
                      key={`h${j}`}
                      p1={vec(0, j * cellSize)}
                      p2={vec(boardWidth, j * cellSize)}
                      color={colors.rule}
                      strokeWidth={1}
                    />
                  ))}

                  {grid.map((row, r) =>
                    row.map((cellData, c) => {
                      const flatIdx = r * COLS + c;
                      const isSelected = selected === flatIdx;
                      const isHint = !!(hintPair && (hintPair[0] === flatIdx || hintPair[1] === flatIdx));
                      const cleared = cellData.cleared;
                      const isWrong = wrongCellId === cellData.id;
                      const x0 = c * cellSize;
                      const y0 = r * cellSize;
                      const cx = x0 + cellSize / 2;
                      const cy = y0 + cellSize / 2;
                      const textWidth = digitWidths[cellData.value] ?? 0;
                      const shakeOffset = isWrong ? wrongShakeNum * 7 : 0;

                      return (
                        <Group key={`cell-${cellData.id}`}>
                          {isSelected && !isWrong && (
                            <Rect x={x0} y={y0} width={cellSize} height={cellSize} color={colors.accentSelect} />
                          )}
                          {isWrong && (
                            <Rect
                              x={x0}
                              y={y0}
                              width={cellSize}
                              height={cellSize}
                              color={lerpColor(colors.accentGold, colors.accentRed, wrongColorNum)}
                            />
                          )}
                          {isHint && !cleared && (
                            <Rect
                              x={x0 + 1}
                              y={y0 + 1}
                              width={cellSize - 2}
                              height={cellSize - 2}
                              color={colors.accentGold}
                              style="stroke"
                              strokeWidth={2}
                            />
                          )}
                          <SkiaText
                            x={cx - textWidth / 2 + shakeOffset}
                            y={cy + cellSize * 0.22}
                            text={String(cellData.value)}
                            font={cellFont}
                            color={
                              cleared
                                ? colors.inkSoft
                                : isSelected || isWrong
                                ? colors.selectText
                                : colors.ink
                            }
                            opacity={cleared ? 0.32 : 1}
                          />
                        </Group>
                      );
                    })
                  )}

                  {matchLine &&
                    matchLine.segments.map((seg, i) => (
                      <Line
                        key={`line-${i}`}
                        p1={vec(seg.x1, seg.y1)}
                        p2={vec(seg.x2, seg.y2)}
                        color={colors.accentLine}
                        style="stroke"
                        strokeWidth={LINE_THICKNESS}
                        strokeCap="round"
                        opacity={lineOpacityNum}
                      />
                    ))}
                </Canvas>
              </View>
            </View>
          </View>

          {won && (
            <View style={styles.winBanner}>
              <Text style={styles.winText}>
                Strona zbilansowana — wszystko skreślone. Wynik końcowy: {score}.
              </Text>
            </View>
          )}

          <View style={styles.controls}>
            <TouchableOpacity
              style={[
                styles.button,
                styles.buttonFlex,
                styles.buttonPrimary,
                (locked || addLimitReached) && styles.buttonDisabled,
              ]}
              disabled={locked || addLimitReached}
              onPress={onAddRemaining}
            >
              <Text style={styles.buttonPrimaryText} numberOfLines={1} adjustsFontSizeToFit>
                Dodaj liczby ({addCount}/{ADD_LIMIT})
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.button,
                styles.buttonFlex,
                (locked || hintLimitReached) && styles.buttonDisabled,
              ]}
              disabled={locked || hintLimitReached}
              onPress={onHint}
            >
              <Text style={styles.buttonText} numberOfLines={1} adjustsFontSizeToFit>
                Podpowiedź ({hintCount}/{HINT_LIMIT})
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.buttonFlex, locked && styles.buttonDisabled]}
              disabled={locked}
              onPress={newGame}
            >
              <Text style={styles.buttonText} numberOfLines={1} adjustsFontSizeToFit>
                Nowa strona
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      <View style={{ height: bottomPad }} />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <GameScreen />
    </SafeAreaProvider>
  );
}

function makeStyles(colors, cellSize, outerPad, boardBorder, boardInnerPad) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: colors.paper2,
    },
    topBar: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'flex-start',
      paddingHorizontal: outerPad,
      gap: 10,
    },
    iconButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.cardEdge,
    },
    iconButtonText: {
      fontSize: 16,
      color: colors.ink,
    },
    infoPanel: {
      position: 'absolute',
      left: outerPad,
      right: outerPad,
      zIndex: 20,
      elevation: 6,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.cardEdge,
      borderRadius: 10,
      padding: 14,
      shadowColor: '#000',
      shadowOpacity: 0.18,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
    },
    infoTitle: {
      fontFamily: SERIF,
      fontWeight: '700',
      fontSize: 15,
      color: colors.ink,
      textAlign: 'center',
      marginBottom: 12,
    },
    infoRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-around',
      rowGap: 12,
    },
    miniExample: {
      alignItems: 'center',
      width: 72,
    },
    miniGrid: {
      borderWidth: 1,
      borderColor: colors.rule,
    },
    miniRow: {
      flexDirection: 'row',
    },
    miniCell: {
      width: 24,
      height: 24,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.paper2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
    },
    miniCellText: {
      fontFamily: MONO,
      fontWeight: '700',
      fontSize: 12,
    },
    miniLabel: {
      marginTop: 6,
      fontSize: 10,
      color: colors.inkSoft,
      textAlign: 'center',
    },
    scrollFlex: {
      flex: 1,
    },
    scroll: {
      flexGrow: 1,
      alignItems: 'center',
      paddingVertical: 20,
      paddingHorizontal: outerPad,
    },
    sheet: {
      width: '100%',
      maxWidth: 640,
    },
    totalsRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-end',
      paddingTop: 4,
      paddingBottom: 6,
    },
    totalsRowRight: {
      flexDirection: 'row',
      gap: 22,
    },
    totalBlock: {
      alignItems: 'flex-end',
    },
    totalBlockLeft: {
      alignItems: 'flex-start',
    },
    totalLabel: {
      fontFamily: MONO,
      fontSize: 10,
      letterSpacing: 1,
      color: colors.inkSoft,
      textTransform: 'uppercase',
    },
    totalLabelWhite: {
      fontFamily: MONO,
      fontSize: 10,
      letterSpacing: 1,
      color: '#ffffff',
      textTransform: 'uppercase',
    },
    totalValue: {
      fontFamily: MONO,
      fontWeight: '700',
      fontSize: 22,
      color: colors.ink,
    },
    totalValueWhite: {
      fontFamily: MONO,
      fontWeight: '700',
      fontSize: 22,
      color: '#ffffff',
    },
    boardWrap: {
      paddingTop: 10,
      marginHorizontal: -outerPad,
    },
    board: {
      backgroundColor: colors.card,
      borderWidth: boardBorder,
      borderColor: colors.ink,
      padding: boardInnerPad,
    },
    winBanner: {
      marginTop: 14,
      backgroundColor: colors.accentGold,
      borderRadius: 4,
      padding: 14,
    },
    winText: {
      fontFamily: SERIF,
      fontWeight: '700',
      fontSize: 16,
      color: colors.paper,
    },
    controls: {
      flexDirection: 'row',
      flexWrap: 'nowrap',
      gap: 8,
      paddingTop: 16,
    },
    button: {
      paddingVertical: 10,
      paddingHorizontal: 8,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: colors.cardEdge,
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonFlex: {
      flex: 1,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    buttonText: {
      fontWeight: '600',
      fontSize: 12,
      color: colors.ink,
      textAlign: 'center',
    },
    buttonPrimary: {
      backgroundColor: colors.accentRed,
      borderColor: colors.accentRed,
    },
    buttonPrimaryText: {
      fontWeight: '600',
      fontSize: 12,
      color: '#fbf6ee',
      textAlign: 'center',
    },
  });
}
