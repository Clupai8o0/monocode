import { router } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";

import { useFileSearch, type FileMatch } from "@/features/connection/useFileSearch";
import { useFileTree, type TreeRow } from "@/features/connection/useFileTree";
import { useSessionLayout } from "@/features/sessions/SessionScreen";
import { GradualBlur } from "@/ui/GradualBlur";
import { Icon } from "@/ui/Icon";
import { themedStyles, useColors } from "@/ui/theme";

import { FileSearchBar, SEARCH_BAR } from "./FileSearchBar";
import { FileTypeIcon } from "./FileTypeIcon";

const ICON = 18;
/** How far each level of the tree steps in. */
const INDENT = 16;
const CARD_MARGIN = 10;
const CARD_RADIUS = 26;
const INSET = 16;
const ICON_GAP = 10;
const CARD_OFFSET = 4;

/**
 * The Android Files page. The same tree, search and sheet as the iOS view, in
 * React Native views: `@expo/ui/swift-ui` has no Android implementation, and
 * rendering one there takes the whole app down (see `WorkspaceMenu.android`).
 *
 * Rows are separated by their own padding rather than by lines, and the list
 * is a `FlatList` so a large folder scrolls at the platform's own speed.
 */
export function FilesView({
  projectId,
  worktreePath,
  active,
}: {
  projectId: string;
  worktreePath?: string;
  /** Whether the page is showing, so folders are only read when looked at. */
  active: boolean;
}) {
  const styles = useStyles();
  const colors = useColors();
  const { pageTop: top, dockBottom } = useSessionLayout();
  const bottom = dockBottom + SEARCH_BAR + 16;
  const tree = useFileTree(projectId, active, worktreePath);
  const [query, setQuery] = useState("");
  const search = useFileSearch(projectId, query, worktreePath);
  const searching = query.trim().length > 0;

  const openFile = (path: string) =>
    router.push({
      pathname: "/file",
      params: { projectId, path, ...(worktreePath ? { worktreePath } : {}) },
    });
  const press = (row: TreeRow) => {
    if (row.entry.isDir) void tree.toggle(row.path);
    else openFile(row.path);
  };

  const empty = searching
    ? (search.error ?? (search.searching ? "Searching…" : "No matching files."))
    : (tree.error ?? (tree.ready ? "This folder is empty." : "Reading from host…"));

  const data = useMemo(
    () => (searching ? search.results : tree.rows),
    [searching, search.results, tree.rows],
  );

  return (
    <>
      <FlatList
        style={styles.list}
        data={data as (TreeRow | FileMatch)[]}
        keyExtractor={(item) => item.path}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: top + CARD_OFFSET,
          paddingBottom: bottom,
          paddingHorizontal: CARD_MARGIN,
        }}
        refreshControl={
          <RefreshControl
            refreshing={tree.refreshing}
            onRefresh={() => void tree.refresh()}
            tintColor={colors.muted}
            colors={[colors.accent]}
            progressViewOffset={top}
          />
        }
        ListEmptyComponent={<Text style={styles.note}>{empty}</Text>}
        renderItem={({ item }) =>
          "entry" in item ? (
            <Row row={item} onPress={() => press(item)} />
          ) : (
            <MatchRow match={item} onPress={() => openFile(item.path)} />
          )
        }
      />
      <GradualBlur edge="bottom" height={bottom} color={colors.background} />
      <FileSearchBar value={query} onChange={setQuery} />
    </>
  );
}

function Row({ row, onPress }: { row: TreeRow; onPress: () => void }) {
  const styles = useStyles();
  const colors = useColors();
  const { entry } = row;
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: colors.selection }}
      style={[
        styles.row,
        { paddingLeft: INSET + row.depth * INDENT },
        entry.ignored && styles.ignored,
      ]}
    >
      {row.loading ? (
        <ActivityIndicator size="small" color={colors.muted} style={styles.icon} />
      ) : (
        <View style={styles.icon}>
          <FileTypeIcon name={entry.name} isDir={entry.isDir} size={ICON} />
        </View>
      )}
      <Text style={styles.name} numberOfLines={1}>
        {entry.name}
      </Text>
      {row.error ? (
        <Text style={styles.detail} numberOfLines={1}>
          {row.error}
        </Text>
      ) : null}
      {entry.isDir ? (
        <Icon
          name={row.expanded ? "chevronDown" : "chevronRight"}
          size={14}
          color={colors.muted}
        />
      ) : null}
    </Pressable>
  );
}

/** A search result: its icon and name, with the folder it is in beside it. */
function MatchRow({ match, onPress }: { match: FileMatch; onPress: () => void }) {
  const styles = useStyles();
  const colors = useColors();
  const dir = match.path.slice(
    0,
    Math.max(0, match.path.length - match.name.length - 1),
  );
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: colors.selection }}
      style={[styles.row, { paddingLeft: INSET }]}
    >
      <View style={styles.icon}>
        <FileTypeIcon name={match.name} isDir={false} size={ICON} />
      </View>
      <Text style={styles.name} numberOfLines={1}>
        {match.name}
      </Text>
      {dir ? (
        <Text style={styles.detail} numberOfLines={1}>
          {dir}
        </Text>
      ) : null}
    </Pressable>
  );
}

const useStyles = themedStyles((colors) => ({
  list: {
    flex: 1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: ICON_GAP,
    paddingVertical: 13,
    paddingRight: INSET,
    backgroundColor: colors.listCard,
    borderRadius: CARD_RADIUS / 2,
    marginBottom: 2,
  },
  ignored: {
    opacity: 0.45,
  },
  icon: {
    width: ICON,
    height: ICON,
    alignItems: "center",
    justifyContent: "center",
  },
  name: {
    flexShrink: 1,
    fontSize: 16,
    color: colors.content,
  },
  detail: {
    flex: 1,
    textAlign: "right",
    fontSize: 13,
    color: colors.muted,
  },
  note: {
    fontSize: 15,
    color: colors.muted,
    paddingVertical: 14,
    paddingHorizontal: INSET,
  },
}));
