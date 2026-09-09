import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

const COLS = 9;

const STRIKE_MS = 200; // how long the strike-through line takes to draw over the number
const SHRINK_MS = 260; // how long the number then takes to shrink and fade away

const PALETTE = {
  light: {
    paper: '#eef2e4',
    paper2: '#e6ebda',
    rule: '#b7cfab',
    ruleStrong: '#8fae82',
    margin: '#c05a4c',
    ink: '#1f2b21',
    inkSoft: '#4a5a44',
    accentRed: '#b23b2e',
    accentRedDeep: '#8f2c22',
    accentGold: '#b3811f',
    card: '#f7f9f0',
    cardEdge: '#d7e0c8',
  },
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
    card: '#152018',
    cardEdge: '#28381f',
  },
};

const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' });
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace', default: 'monospace' });

let nextId = 1;
function freshId() {
  return nextId++;
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

export default function App() {
  const scheme = useColorScheme();
  const colors = PALETTE[scheme === 'dark' ? 'dark' : 'light'];
  const { width } = useWindowDimensions();

  const [grid, setGrid] = useState(makeInitialGrid);
  const [selected, setSelected] = useState(null);
  const [score, setScore] = useState(0);
  const [won, setWon] = useState(false);
  const [toast, setToast] = useState('');
  const [hintPair, setHintPair] = useState(null);
  const [locked, setLocked] = useState(false);
  const toastTimer = useRef(null);
  const hintTimer = useRef(null);
  const lockedRef = useRef(false);

  // Per-cell Animated values, keyed by the cell's stable id (survives row pruning).
  const animMap = useRef(new Map());
  const getAnim = useCallback((id) => {
    let a = animMap.current.get(id);
    if (!a) {
      a = {
        strike: new Animated.Value(0),
        scale: new Animated.Value(1),
        opacity: new Animated.Value(1),
      };
      animMap.current.set(id, a);
    }
    return a;
  }, []);

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

  const newGame = useCallback(() => {
    if (lockedRef.current) return;
    animMap.current.clear();
    setGrid(makeInitialGrid());
    setSelected(null);
    setScore(0);
    setWon(false);
    setHintPair(null);
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
    (a, b, distant) => {
      lockedRef.current = true;
      setLocked(true);

      const animA = getAnim(a.cell.id);
      const animB = getAnim(b.cell.id);
      [animA, animB].forEach((anim) => {
        anim.strike.setValue(0);
        anim.scale.setValue(1);
        anim.opacity.setValue(1);
      });

      const sequenceFor = (anim) =>
        Animated.sequence([
          Animated.timing(anim.strike, {
            toValue: 1,
            duration: STRIKE_MS,
            useNativeDriver: false,
          }),
          Animated.parallel([
            Animated.timing(anim.scale, {
              toValue: 0,
              duration: SHRINK_MS,
              useNativeDriver: true,
            }),
            Animated.timing(anim.opacity, {
              toValue: 0,
              duration: SHRINK_MS,
              useNativeDriver: true,
            }),
          ]),
        ]);

      Animated.parallel([sequenceFor(animA), sequenceFor(animB)]).start(() => {
        commitMatch(a, b, distant);
      });
    },
    [commitMatch, getAnim]
  );

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
        setSelected(null);
        animateMatch(a, b, distant);
      } else {
        setSelected(idx);
      }
    },
    [grid, selected, won, animateMatch]
  );

  const onAddRemaining = useCallback(() => {
    if (won || lockedRef.current) return;
    const leftovers = [];
    for (const row of grid)
      for (const cell of row) if (!cell.cleared) leftovers.push({ id: cell.id, value: cell.value, cleared: false });
    if (leftovers.length === 0) {
      showToast('Nie ma nic do dołożenia.');
      return;
    }
    const newRows = [];
    for (let i = 0; i < leftovers.length; i += COLS) {
      const slice = leftovers.slice(i, i + COLS);
      while (slice.length < COLS) slice.push({ id: freshId(), value: 0, cleared: true });
      newRows.push(slice);
    }
    setGrid((g) => g.concat(newRows));
    setSelected(null);
    showToast(`Dołożono ${leftovers.length} liczb.`);
  }, [grid, won, showToast]);

  const onHint = useCallback(() => {
    if (won || lockedRef.current) return;
    const match = findAnyMatch(grid);
    if (match) {
      setSelected(null);
      setHintPair(match);
      if (hintTimer.current) clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setHintPair(null), 1900);
    } else {
      showToast('Brak pary na planszy — dołóż liczby.');
    }
  }, [grid, won, showToast]);

  const outerPad = 20;
  const boardBorder = 3;
  const boardInnerPad = 4;
  const cellSize = Math.floor(
    (Math.min(width, 640) - boardBorder * 2 - boardInnerPad * 2) / COLS
  );

  const styles = useMemo(
    () => makeStyles(colors, cellSize, outerPad, boardBorder, boardInnerPad),
    [colors, cellSize]
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.kicker}>BLOCZEK KOLUMNOWY · NR 10</Text>
            <Text style={styles.h1}>
              Księga <Text style={styles.h1Italic}>Dziesiątek</Text>
            </Text>
            <Text style={styles.subhead}>
              Skreślaj pary, które pasują — równe cyfry albo takie, które dają w sumie dziesięć.
              Wyczyść całą stronę i zamknij księgę.
            </Text>
          </View>

          <View style={styles.totalsRow}>
            <View style={styles.totalBlock}>
              <Text style={styles.totalLabel}>Zostało</Text>
              <Text style={styles.totalValue}>{remaining}</Text>
            </View>
            <View style={styles.totalBlock}>
              <Text style={styles.totalLabel}>Wynik</Text>
              <Text style={[styles.totalValue, { color: colors.accentGold }]}>{score}</Text>
            </View>
          </View>

          <View style={styles.boardWrap}>
            <View style={styles.board}>
              {grid.map((row, r) => (
                <View key={`row-${r}`} style={styles.boardRow}>
                  {row.map((cellData, c) => {
                    const flatIdx = r * COLS + c;
                    const isSelected = selected === flatIdx;
                    const isHint = hintPair && (hintPair[0] === flatIdx || hintPair[1] === flatIdx);
                    const cleared = cellData.cleared;
                    const anim = !cleared ? getAnim(cellData.id) : null;
                    const strikeWidth = anim
                      ? anim.strike.interpolate({ inputRange: [0, 1], outputRange: ['0%', '86%'] })
                      : '0%';

                    return (
                      <TouchableOpacity
                        key={`cell-${cellData.id}`}
                        activeOpacity={cleared ? 1 : 0.6}
                        disabled={cleared || won || locked}
                        onPress={() => onCellPress(flatIdx)}
                        style={[
                          styles.cell,
                          cleared && styles.cellCleared,
                          isSelected && styles.cellSelected,
                          isHint && styles.cellHint,
                        ]}
                      >
                        {!cleared && (
                          <Animated.View
                            style={{
                              opacity: anim.opacity,
                              transform: [{ scale: anim.scale }],
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Text style={[styles.cellText, isSelected && styles.cellTextSelected]}>
                              {cellData.value}
                            </Text>
                            <Animated.View
                              pointerEvents="none"
                              style={[
                                styles.strikeLine,
                                {
                                  width: strikeWidth,
                                  backgroundColor: isSelected ? colors.paper : colors.accentRed,
                                },
                              ]}
                            />
                          </Animated.View>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ))}
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
              style={[styles.button, styles.buttonPrimary, locked && styles.buttonDisabled]}
              disabled={locked}
              onPress={onAddRemaining}
            >
              <Text style={styles.buttonPrimaryText}>Dołóż pozostałe liczby</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, locked && styles.buttonDisabled]}
              disabled={locked}
              onPress={onHint}
            >
              <Text style={styles.buttonText}>Podpowiedź</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, locked && styles.buttonDisabled]}
              disabled={locked}
              onPress={newGame}
            >
              <Text style={styles.buttonText}>Nowa strona</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.footnote}>
            <Text style={{ fontWeight: '700', color: colors.ink }}>Jak łączyć: </Text>
            dwie liczby pasują, gdy stoją obok siebie (także po skosie), gdy wszystkie liczby
            między nimi w czytaniu wierszami są już skreślone, albo gdy łączy je czysta linia w
            poziomie, w pionie lub po przekątnej bez żadnej przeszkody. Odległe pary dają więcej
            punktów.
          </Text>

          {!!toast && (
            <View style={styles.toast}>
              <Text style={styles.toastText}>{toast}</Text>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors, cellSize, outerPad, boardBorder, boardInnerPad) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: colors.paper,
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
    header: {
      paddingTop: 6,
      paddingBottom: 10,
    },
    kicker: {
      fontFamily: MONO,
      fontSize: 11,
      letterSpacing: 1.4,
      color: colors.inkSoft,
    },
    h1: {
      fontFamily: SERIF,
      fontWeight: '700',
      fontSize: 30,
      color: colors.ink,
      marginTop: 4,
      marginBottom: 6,
    },
    h1Italic: {
      fontStyle: 'italic',
      color: colors.accentRed,
    },
    subhead: {
      fontSize: 13.5,
      lineHeight: 20,
      color: colors.inkSoft,
      maxWidth: 480,
    },
    totalsRow: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 22,
      paddingVertical: 6,
    },
    totalBlock: {
      alignItems: 'flex-end',
    },
    totalLabel: {
      fontFamily: MONO,
      fontSize: 10,
      letterSpacing: 1,
      color: colors.inkSoft,
      textTransform: 'uppercase',
    },
    totalValue: {
      fontFamily: MONO,
      fontWeight: '700',
      fontSize: 22,
      color: colors.ink,
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
    boardRow: {
      flexDirection: 'row',
    },
    cell: {
      width: cellSize,
      height: cellSize,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'transparent',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
    },
    cellCleared: {
      backgroundColor: colors.paper2,
    },
    cellSelected: {
      backgroundColor: colors.accentGold,
      borderColor: colors.accentGold,
    },
    cellHint: {
      borderColor: colors.accentGold,
      borderWidth: 2,
    },
    cellText: {
      fontFamily: MONO,
      fontWeight: '700',
      fontSize: Math.round(cellSize * 0.62),
      color: colors.ink,
    },
    cellTextSelected: {
      color: colors.paper,
    },
    strikeLine: {
      position: 'absolute',
      alignSelf: 'center',
      top: '50%',
      height: 2.5,
      borderRadius: 1.5,
      marginTop: -1.25,
      transform: [{ rotate: '-6deg' }],
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
      flexWrap: 'wrap',
      gap: 10,
      paddingTop: 16,
    },
    button: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: colors.cardEdge,
      backgroundColor: colors.card,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    buttonText: {
      fontWeight: '600',
      fontSize: 13,
      color: colors.ink,
    },
    buttonPrimary: {
      backgroundColor: colors.accentRed,
      borderColor: colors.accentRed,
    },
    buttonPrimaryText: {
      fontWeight: '600',
      fontSize: 13,
      color: '#fbf6ee',
    },
    footnote: {
      paddingTop: 16,
      fontSize: 12,
      lineHeight: 18,
      color: colors.inkSoft,
      maxWidth: 520,
    },
    toast: {
      marginTop: 14,
      alignSelf: 'flex-start',
      backgroundColor: colors.ink,
      borderRadius: 4,
      paddingVertical: 8,
      paddingHorizontal: 14,
    },
    toastText: {
      color: colors.paper,
      fontSize: 13,
      fontWeight: '500',
    },
  });
}
