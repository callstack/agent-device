- Fixed (android): snapshot nodes and `get attrs` carry the accessibility `heading` flag and the
  `roleDescription` an app set on a node. React Native puts a header, a tab, a tab list, a link, or a
  menu on a plain `android.view.View` and tells the accessibility tree what it is through these two
  facts; the helper never serialized either, so every one of them was a nameless `View` to an agent.
  The helper now writes `heading` when the node reports it (API 28 or later) and `role-description`
  when the app set one, and the parser, the Android hierarchy node, and the published snapshot node
  carry them to `get attrs` and the selector digest. The class stays the `type`.
