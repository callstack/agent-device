import { useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { clampInteger } from '../route-params';
import { useAppColors, type AppColors } from '../theme';

/**
 * A JavaScript-only reproduction of a heavy React Native home feed, shaped after Bluesky 1.136.
 * `wrappers` nested containers stand in for its navigation, provider, and screen layers. Below them
 * a virtualized list renders composite posts five to ten levels deep, and quote-with-media embeds
 * add more. With the defaults the deepest post node sits more than 65 levels below the application,
 * so the XCTest tree capture degrades as it does on Bluesky. Every level opts out of view
 * flattening, so the native hierarchy is as deep as the React tree.
 */
export function HeavyFeedScreen() {
  const colors = useAppColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const params = useLocalSearchParams<{ wrappers?: string; posts?: string }>();
  const wrappers = clampInteger(params.wrappers, 30, 0, 80);
  const postCount = clampInteger(params.posts, 60, 1, 300);
  const posts = useMemo(() => buildPosts(postCount), [postCount]);
  const [liked, setLiked] = useState<ReadonlySet<number>>(new Set());
  const [lastAction, setLastAction] = useState('none');
  const [tab, setTab] = useState<'following' | 'discover'>('following');

  const toggleLike = useCallback((id: number) => {
    setLiked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setLastAction(`${next.has(id) ? 'liked' : 'unliked'} post ${id}`);
      return next;
    });
  }, []);
  const holdPost = useCallback((id: number) => setLastAction(`held post ${id}`), []);

  const feed = (
    <View collapsable={false} style={styles.frame} testID="heavy-feed-root">
      <View collapsable={false} style={styles.header}>
        <Text accessibilityRole="header" style={styles.title} testID="heavy-feed-title">
          Heavy feed
        </Text>
        <View collapsable={false} style={styles.tabs}>
          {(['following', 'discover'] as const).map((name) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: tab === name }}
              key={name}
              onPress={() => {
                setTab(name);
                setLastAction(`tab ${name}`);
              }}
              style={[styles.tab, tab === name ? styles.tabSelected : null]}
              testID={`heavy-feed-tab-${name}`}
            >
              <Text style={styles.tabLabel}>{name === 'following' ? 'Following' : 'Discover'}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.status} testID="heavy-feed-liked-count">
          Liked posts: {liked.size}
        </Text>
        <Text style={styles.status} testID="heavy-feed-last-action">
          Last action: {lastAction}
        </Text>
      </View>
      <FlatList
        data={posts}
        extraData={liked}
        initialNumToRender={6}
        keyExtractor={(post) => String(post.id)}
        renderItem={({ item }) => (
          <PostCard
            liked={liked.has(item.id)}
            onHold={holdPost}
            onLike={toggleLike}
            post={item}
            styles={styles}
          />
        )}
        testID="heavy-feed-list"
        windowSize={5}
      />
    </View>
  );

  return (
    <ShellLayers count={wrappers} styles={styles}>
      {feed}
    </ShellLayers>
  );
}

type Embed = 'none' | 'image' | 'link' | 'quote' | 'quote-media';

type Post = {
  id: number;
  author: string;
  handle: string;
  age: string;
  text: string;
  embed: Embed;
  replies: number;
  reposts: number;
  likes: number;
};

const AUTHORS = ['Ada Byron', 'Grace Hopper', 'Alan Turing', 'Edsger Dijkstra', 'Barbara Liskov'];
const EMBEDS: readonly Embed[] = ['quote-media', 'none', 'image', 'quote', 'link'];

function buildPosts(count: number): Post[] {
  return Array.from({ length: count }, (_, id) => {
    const author = AUTHORS[id % AUTHORS.length]!;
    return {
      id,
      author,
      handle: `@${author.toLowerCase().replace(' ', '.')}.example`,
      age: `${(id % 23) + 1}h`,
      text: `Post ${id}: a deterministic feed entry with enough copy to wrap onto a second line.`,
      embed: EMBEDS[id % EMBEDS.length]!,
      replies: (id * 7) % 31,
      reposts: (id * 5) % 17,
      likes: (id * 11) % 97,
    };
  });
}

function ShellLayers({
  count,
  styles,
  children,
}: {
  count: number;
  styles: Styles;
  children: ReactNode;
}) {
  let tree = children;
  for (let level = count - 1; level >= 0; level -= 1) {
    tree = (
      <View collapsable={false} style={styles.shell} testID={`heavy-shell-${level}`}>
        {tree}
      </View>
    );
  }
  return tree;
}

function PostCard({
  post,
  liked,
  onLike,
  onHold,
  styles,
}: {
  post: Post;
  liked: boolean;
  onLike: (id: number) => void;
  onHold: (id: number) => void;
  styles: Styles;
}) {
  const id = `heavy-post-${post.id}`;
  return (
    <View collapsable={false} style={styles.post} testID={id}>
      <Pressable accessible={false} collapsable={false} onLongPress={() => onHold(post.id)}>
        <View collapsable={false} style={styles.postRow}>
          <View
            accessibilityLabel={`Avatar of ${post.author}`}
            accessibilityRole="image"
            accessible
            style={styles.avatar}
          />
          <View collapsable={false} style={styles.postContent} testID={`${id}-content`}>
            <View collapsable={false} style={styles.postMeta}>
              <Text style={styles.author}>{post.author}</Text>
              <Text style={styles.soft}>
                {post.handle} · {post.age}
              </Text>
            </View>
            <View collapsable={false}>
              <Text style={styles.body}>{post.text}</Text>
            </View>
            <PostEmbed embed={post.embed} postId={post.id} styles={styles} />
            <View collapsable={false} style={styles.actions} testID={`${id}-actions`}>
              <ActionButton
                count={post.replies}
                label="Reply"
                styles={styles}
                testID={`${id}-reply`}
              />
              <ActionButton
                count={post.reposts}
                label="Repost"
                styles={styles}
                testID={`${id}-repost`}
              />
              <ActionButton
                count={post.likes + (liked ? 1 : 0)}
                label={liked ? 'Unlike' : 'Like'}
                onPress={() => onLike(post.id)}
                selected={liked}
                styles={styles}
                testID={`${id}-like`}
              />
              <ActionButton label="More options" styles={styles} testID={`${id}-more`} />
            </View>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

function ActionButton({
  label,
  count,
  onPress,
  selected = false,
  styles,
  testID,
}: {
  label: string;
  count?: number;
  onPress?: () => void;
  selected?: boolean;
  styles: Styles;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityLabel={count === undefined ? label : `${label} (${count})`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={styles.action}
      testID={testID}
    >
      <View collapsable={false} style={styles.actionInner}>
        <Text style={selected ? styles.actionSelected : styles.soft}>
          {count === undefined ? '…' : count}
        </Text>
      </View>
    </Pressable>
  );
}

function PostEmbed({ embed, postId, styles }: { embed: Embed; postId: number; styles: Styles }) {
  if (embed === 'none') return null;
  if (embed === 'image') return <MediaGrid postId={postId} styles={styles} tiles={1} />;
  if (embed === 'link') {
    return (
      <View collapsable={false} style={styles.embed} testID={`heavy-post-${postId}-link`}>
        <View collapsable={false} style={styles.linkThumb} />
        <View collapsable={false}>
          <Text style={styles.author}>example.com</Text>
          <Text style={styles.soft}>A link card with a title and a description.</Text>
        </View>
      </View>
    );
  }
  return (
    <View collapsable={false} style={styles.embed} testID={`heavy-post-${postId}-quote`}>
      <View collapsable={false}>
        <View collapsable={false}>
          <View collapsable={false} style={styles.quoteBody}>
            <View collapsable={false} style={styles.postMeta}>
              <View collapsable={false} style={styles.quoteAvatar} />
              <Text style={styles.author}>Quoted author</Text>
            </View>
            <View collapsable={false}>
              <View collapsable={false}>
                <Text style={styles.body}>A quoted post embedded inside post {postId}.</Text>
              </View>
            </View>
            {embed === 'quote-media' ? (
              <MediaGrid postId={postId} styles={styles} tiles={4} />
            ) : null}
          </View>
        </View>
      </View>
    </View>
  );
}

function MediaGrid({ postId, tiles, styles }: { postId: number; tiles: number; styles: Styles }) {
  return (
    <View collapsable={false} style={styles.media} testID={`heavy-post-${postId}-media`}>
      <View collapsable={false}>
        <View collapsable={false} style={styles.mediaRow}>
          {Array.from({ length: tiles }, (_, index) => (
            <View collapsable={false} key={index} style={styles.mediaCell}>
              <View collapsable={false} style={styles.mediaFrame}>
                <Pressable accessible={false} collapsable={false} style={styles.mediaImage}>
                  <View
                    accessibilityLabel={`Image ${index + 1} of post ${postId}`}
                    accessibilityRole="image"
                    accessible
                    style={styles.mediaImage}
                  />
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

type Styles = ReturnType<typeof createStyles>;

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    shell: { flex: 1 },
    frame: { flex: 1, backgroundColor: colors.surface },
    header: {
      borderBottomColor: colors.line,
      borderBottomWidth: 1,
      gap: 4,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    title: { color: colors.text, fontSize: 20, fontWeight: '700' },
    tabs: { flexDirection: 'row', gap: 8 },
    tab: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 },
    tabSelected: { backgroundColor: colors.accentSoft },
    tabLabel: { color: colors.text, fontWeight: '600' },
    status: { color: colors.textSoft, fontSize: 12 },
    post: { borderBottomColor: colors.line, borderBottomWidth: 1, padding: 12 },
    postRow: { flexDirection: 'row', gap: 10 },
    avatar: { backgroundColor: colors.accentSoft, borderRadius: 20, height: 40, width: 40 },
    postContent: { flex: 1, gap: 6 },
    postMeta: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    author: { color: colors.text, fontWeight: '600' },
    soft: { color: colors.textSoft, fontSize: 12 },
    body: { color: colors.text },
    embed: {
      borderColor: colors.lineStrong,
      borderRadius: 10,
      borderWidth: 1,
      gap: 6,
      padding: 8,
    },
    quoteBody: { gap: 6 },
    quoteAvatar: { backgroundColor: colors.cardStrong, borderRadius: 8, height: 16, width: 16 },
    linkThumb: { backgroundColor: colors.cardStrong, borderRadius: 6, height: 48 },
    media: { borderRadius: 8, overflow: 'hidden' },
    mediaRow: { flexDirection: 'row', gap: 2 },
    mediaCell: { flex: 1 },
    mediaFrame: { aspectRatio: 1 },
    mediaImage: { backgroundColor: colors.accentSoft, flex: 1 },
    actions: { flexDirection: 'row', justifyContent: 'space-between' },
    action: { minWidth: 44, paddingVertical: 4 },
    actionInner: { alignItems: 'center' },
    actionSelected: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  });
}
