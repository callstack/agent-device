package dev.agentdevice.conformance

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.databind.node.ArrayNode
import com.fasterxml.jackson.databind.node.ObjectNode
import maestro.ElementFilter
import maestro.Filters
import maestro.TreeNode

@JsonInclude(JsonInclude.Include.NON_NULL)
private data class TreeSelector(
    val id: String? = null,
    val text: String? = null,
    val index: Int? = null,
    val childOf: TreeSelector? = null,
    val containsChild: TreeSelector? = null,
    val containsDescendants: List<TreeSelector>? = null,
)

@JsonInclude(JsonInclude.Include.NON_NULL)
private data class FixtureNode(
    val key: String,
    val parentKey: String?,
    val identifier: String,
    val label: String?,
    val rect: FixtureRect,
)

private data class FixtureRect(
    val x: Int,
    val y: Int,
    val width: Int = 40,
    val height: Int = 30,
)

private data class TreeVector(
    val id: String,
    val operation: String,
    val selector: TreeSelector,
    val nodes: List<FixtureNode>,
    val matches: List<String>,
    val selected: String?,
)

private data class NodeSpec(
    val key: String,
    val resourceId: String = key,
    val x: Int = 0,
    val y: Int = 0,
    val text: String? = null,
    val children: List<NodeSpec> = emptyList(),
)

/** Emit vectors from the pinned Filters implementation, never hand-written answers. */
fun emitTreeVectors(target: ArrayNode) {
    for (vector in TREE_VECTORS) {
        val node = target.addObject()
        node.put("id", vector.id)
        node.put("operation", vector.operation)
        node.set<ObjectNode>("selector", fixtureMapper.valueToTree(vector.selector))
        node.set<ObjectNode>("nodes", fixtureMapper.valueToTree(vector.nodes))
        node.putArray("matches").also { vector.matches.forEach(it::add) }
        vector.selected?.let { node.put("selected", it) }
    }
}

/** Small immutable hierarchies exercised through pinned Maestro v2.5.1 Filters. */
private val TREE_VECTORS: List<TreeVector> = listOf(
    treeVector(
        "containsChild-direct-only",
        "intersect(id=card, containsChild(id=direct))",
        listOf(node("card", children = listOf(node("direct"), node("nested-parent", children = listOf(node("nested"))))), node("outside", children = listOf(node("direct-outside")))),
        TreeSelector(id = "card", containsChild = TreeSelector(id = "direct")),
        intersect(id("card"), child(id("direct"))),
    ),
    treeVector(
        "containsDescendants-any-depth",
        "intersect(id=card, containsDescendants(id=nested))",
        listOf(
            node(
                "card",
                children = listOf(
                    node("direct"),
                    node("nested-parent", children = listOf(node("nested"))),
                ),
            ),
        ),
        TreeSelector(id = "card", containsDescendants = listOf(TreeSelector(id = "nested"))),
        intersect(id("card"), descendants(id("nested"))),
    ),
    treeVector(
        "containsDescendants-all-clauses",
        "intersect(id=card, containsDescendants(id=title, text=Badge))",
        listOf(
            node("complete-card", resourceId = "card", children = listOf(node("title", resourceId = "title", text = "Title"), node("badge", text = "Badge", children = listOf(node("badge-icon"))))),
            node("partial-card", resourceId = "card", children = listOf(node("title-2", resourceId = "title", text = "Title"))),
        ),
        TreeSelector(id = "card", containsDescendants = listOf(TreeSelector(id = "title"), TreeSelector(text = "Badge"))),
        intersect(id("card"), descendants(id("title"), text("Badge"))),
    ),
    treeVector(
        "nested-tree-relations",
        "intersect(id=card, containsChild(intersect(id=panel, containsChild(id=title), containsDescendants(id=icon))))",
        listOf(
            node("card", children = listOf(node("panel", children = listOf(node("title"), node("panel-icon-wrapper", children = listOf(node("icon"))))), node("unrelated"))),
            node("card-missing-nested", resourceId = "card", children = listOf(node("panel-missing", resourceId = "panel", children = listOf(node("title"))))),
        ),
        TreeSelector(id = "card", containsChild = TreeSelector(id = "panel", containsChild = TreeSelector(id = "title"), containsDescendants = listOf(TreeSelector(id = "icon")))),
        intersect(id("card"), child(intersect(id("panel"), child(id("title")), descendants(id("icon"))))),
    ),
    treeVector(
        "tree-composition-index-yx",
        "compose(intersect(id=card, containsChild(id=title), containsDescendants(id=icon)), index=0)",
        listOf(
            node("card-low-x", resourceId = "card", x = 0, y = 220, children = listOf(node("title-low-x", resourceId = "title", x = 8, y = 228), node("icon-low-x", resourceId = "icon", x = 8, y = 260))),
            node("card-high-x", resourceId = "card", x = 160, y = 80, children = listOf(node("title-high-x", resourceId = "title", x = 168, y = 88), node("icon-high-x", resourceId = "icon", x = 168, y = 120))),
        ),
        TreeSelector(id = "card", index = 0, containsChild = TreeSelector(id = "title"), containsDescendants = listOf(TreeSelector(id = "icon"))),
        composedTreeFilter(),
        Filters.compose(composedTreeFilter(), Filters.index(0)),
    ),
)

private fun treeVector(
    id: String,
    operation: String,
    roots: List<NodeSpec>,
    selector: TreeSelector,
    filter: ElementFilter,
    selectionFilter: ElementFilter? = null,
): TreeVector {
    val flattened = roots.flatMap { it.toTreeNode().aggregate() }
    val matches = filter(flattened).map { it.attributes.getValue("key") }
    val selected = (selectionFilter ?: filter)(flattened).singleOrNull()?.attributes?.get("key")
    return TreeVector(id, operation, selector, roots.flatMap { it.toFixtureNodes() }, matches, selected)
}

private fun id(value: String): ElementFilter = Filters.idMatches(Regex(value))
private fun text(value: String): ElementFilter = Filters.textMatches(Regex(value))
private fun child(filter: ElementFilter): ElementFilter = Filters.containsChild(filter)
private fun descendants(vararg filters: ElementFilter): ElementFilter = Filters.containsDescendants(filters.toList())
private fun intersect(vararg filters: ElementFilter): ElementFilter = Filters.intersect(filters.toList())
private fun composedTreeFilter(): ElementFilter = intersect(id("card"), child(id("title")), descendants(id("icon")))

private fun node(
    key: String,
    resourceId: String = key,
    x: Int = 0,
    y: Int = 0,
    text: String? = null,
    children: List<NodeSpec> = emptyList(),
): NodeSpec = NodeSpec(key, resourceId, x, y, text, children)

private fun NodeSpec.toTreeNode(): TreeNode {
    val attributes = mutableMapOf("key" to key, "resource-id" to resourceId, "bounds" to "[$x,$y][${x + 40},${y + 30}]")
    text?.let { attributes["text"] = it }
    return TreeNode(attributes = attributes, children = children.map { it.toTreeNode() })
}

private fun NodeSpec.toFixtureNodes(parentKey: String? = null): List<FixtureNode> = listOf(
    FixtureNode(key, parentKey, resourceId, text, FixtureRect(x, y)),
) + children.flatMap { it.toFixtureNodes(key) }
