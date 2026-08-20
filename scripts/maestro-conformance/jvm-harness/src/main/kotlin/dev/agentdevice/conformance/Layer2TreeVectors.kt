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
    val below: TreeSelector? = null,
    val above: TreeSelector? = null,
    val leftOf: TreeSelector? = null,
    val rightOf: TreeSelector? = null,
    val containsChild: TreeSelector? = null,
    val containsDescendants: List<TreeSelector>? = null,
)

@JsonInclude(JsonInclude.Include.NON_NULL)
private data class FixtureNode(
    val key: String,
    val parentKey: String?,
    val identifier: String,
    val label: String?,
    val rect: FixtureRect?,
    val clickable: Boolean?,
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
    val intermediateRelation: String? = null,
    val intermediate: List<String>? = null,
    val clickableFirstMatches: List<String>? = null,
)

private data class NodeSpec(
    val key: String,
    val resourceId: String = key,
    val x: Int = 0,
    val y: Int = 0,
    val text: String? = null,
    val children: List<NodeSpec> = emptyList(),
    val hasBounds: Boolean = true,
    val width: Int = 40,
    val height: Int = 30,
    val clickable: Boolean? = null,
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
        vector.intermediateRelation?.let { node.put("intermediateRelation", it) }
        vector.intermediate?.let { values ->
            node.putArray("intermediate").also { values.forEach(it::add) }
        }
        vector.clickableFirstMatches?.let { values ->
            node.putArray("clickableFirstMatches").also { values.forEach(it::add) }
        }
    }
}

/** Small immutable hierarchies exercised through pinned Maestro v2.5.1 Filters. */
private val TREE_VECTORS: List<TreeVector> = listOf(
    treeVector(
        "containsChild-direct-only",
        "intersect(id=card, containsChild(id=direct))",
        listOf(
            node(
                "card",
                children = listOf(
                    node("direct"),
                    node("nested-parent", children = listOf(node("nested"))),
                ),
            ),
            node("outside", children = listOf(node("direct-outside"))),
        ),
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
            node(
                "complete-card",
                resourceId = "card",
                children = listOf(
                    node("title", resourceId = "title", text = "Title"),
                    node("badge", text = "Badge", children = listOf(node("badge-icon"))),
                ),
            ),
            node(
                "partial-card",
                resourceId = "card",
                children = listOf(node("title-2", resourceId = "title", text = "Title")),
            ),
        ),
        TreeSelector(id = "card", containsDescendants = listOf(TreeSelector(id = "title"), TreeSelector(text = "Badge"))),
        intersect(id("card"), descendants(id("title"), text("Badge"))),
    ),
    treeVector(
        "clickable-first-tristate-stable",
        "compose(intersect(id=candidate), clickableFirst()) preserves true/false/absent groups",
        listOf(
            node("false-first", resourceId = "candidate", clickable = false),
            node("true-first", resourceId = "candidate", clickable = true),
            node("absent", resourceId = "candidate"),
            node("true-second", resourceId = "candidate", clickable = true),
            node("false-second", resourceId = "candidate", clickable = false),
        ),
        TreeSelector(id = "candidate"),
        id("candidate"),
        emitClickableOrder = true,
    ),
    treeVector(
        "clickable-first-index-bypass",
        "compose(intersect(id=candidate), index=0) keeps y/x ordering and bypasses clickableFirst",
        listOf(
            node("clickable-later", resourceId = "candidate", x = 0, y = 200, clickable = true),
            node("nonclickable-top", resourceId = "candidate", x = 10, y = 20, clickable = false),
        ),
        TreeSelector(id = "candidate", index = 0),
        id("candidate"),
        Filters.compose(id("candidate"), Filters.index(0)),
    ),
    treeVector(
        "nested-tree-relations",
        "intersect(id=card, containsChild(intersect(id=panel, containsChild(id=title), containsDescendants(id=icon))))",
        listOf(
            node(
                "card",
                children = listOf(
                    node(
                        "panel",
                        children = listOf(
                            node("title"),
                            node("panel-icon-wrapper", children = listOf(node("icon"))),
                        ),
                    ),
                    node("unrelated"),
                ),
            ),
            node(
                "card-missing-nested",
                resourceId = "card",
                children = listOf(
                    node(
                        "panel-missing",
                        resourceId = "panel",
                        children = listOf(node("title")),
                    ),
                ),
            ),
        ),
        TreeSelector(id = "card", containsChild = TreeSelector(id = "panel", containsChild = TreeSelector(id = "title"), containsDescendants = listOf(TreeSelector(id = "icon")))),
        intersect(id("card"), child(intersect(id("panel"), child(id("title")), descendants(id("icon"))))),
    ),
    treeVector(
        "tree-composition-index-yx",
        "compose(intersect(id=card, containsChild(id=title), containsDescendants(id=icon)), index=0)",
        listOf(
            node(
                "card-low-x",
                resourceId = "card",
                x = 0,
                y = 220,
                children = listOf(
                    node("title-low-x", resourceId = "title", x = 8, y = 228),
                    node("icon-low-x", resourceId = "icon", x = 8, y = 260),
                ),
            ),
            node(
                "card-high-x",
                resourceId = "card",
                x = 160,
                y = 80,
                children = listOf(
                    node("title-high-x", resourceId = "title", x = 168, y = 88),
                    node("icon-high-x", resourceId = "icon", x = 168, y = 120),
                ),
            ),
        ),
        TreeSelector(id = "card", index = 0, containsChild = TreeSelector(id = "title"), containsDescendants = listOf(TreeSelector(id = "icon"))),
        composedTreeFilter(),
        Filters.compose(composedTreeFilter(), Filters.index(0)),
    ),
    treeVector(
        "position-below-strict-top-left",
        "intersect(id=candidate, below(id=anchor))",
        listOf(
            node("candidate-above", resourceId = "candidate", y = 40),
            node("candidate-equal", resourceId = "candidate", y = 100),
            node("candidate-below", resourceId = "candidate", y = 160),
            node("anchor", resourceId = "anchor", y = 100),
        ),
        TreeSelector(id = "candidate", below = TreeSelector(id = "anchor")),
        intersect(id("candidate"), below(id("anchor"))),
    ),
    treeVector(
        "position-above-strict-top-left",
        "intersect(id=candidate, above(id=anchor))",
        listOf(
            node("candidate-above", resourceId = "candidate", y = 40),
            node("candidate-equal", resourceId = "candidate", y = 100),
            node("candidate-below", resourceId = "candidate", y = 160),
            node("anchor", resourceId = "anchor", y = 100),
        ),
        TreeSelector(id = "candidate", above = TreeSelector(id = "anchor")),
        intersect(id("candidate"), above(id("anchor"))),
    ),
    treeVector(
        "position-left-right-strict-top-left",
        "leftOf/rightOf use strict candidate-vs-anchor bounds.x",
        listOf(
            node("left", resourceId = "candidate", x = 20),
            node("equal", resourceId = "candidate", x = 100),
            node("right", resourceId = "candidate", x = 180),
            node("anchor", resourceId = "anchor", x = 100),
        ),
        TreeSelector(id = "candidate", leftOf = TreeSelector(id = "anchor")),
        intersect(id("candidate"), leftOf(id("anchor"))),
    ),
    treeVector(
        "position-right-strict-top-left",
        "intersect(id=candidate, rightOf(id=anchor))",
        listOf(
            node("left", resourceId = "candidate", x = 20),
            node("equal", resourceId = "candidate", x = 100),
            node("right", resourceId = "candidate", x = 180),
            node("anchor", resourceId = "anchor", x = 100),
        ),
        TreeSelector(id = "candidate", rightOf = TreeSelector(id = "anchor")),
        intersect(id("candidate"), rightOf(id("anchor"))),
    ),
    treeVector(
        "position-multiple-anchors-distance-intermediate",
        "intersect(id=candidate, below(id=anchor)); relativeTo pair order is intermediate",
        listOf(
            node("far-candidate", resourceId = "candidate", x = 300, y = 240),
            node("near-candidate", resourceId = "candidate", x = 40, y = 140),
            node("near-anchor", resourceId = "anchor", x = 40, y = 40),
            node("far-anchor", resourceId = "anchor", x = 300, y = 40),
        ),
        TreeSelector(id = "candidate", below = TreeSelector(id = "anchor")),
        intersect(id("candidate"), below(id("anchor"))),
        intermediateRelation = "below",
        intermediate = below(id("anchor"))(listOf(
            node("far-candidate", resourceId = "candidate", x = 300, y = 240).toTreeNode(),
            node("near-candidate", resourceId = "candidate", x = 40, y = 140).toTreeNode(),
            node("near-anchor", resourceId = "anchor", x = 40, y = 40).toTreeNode(),
            node("far-anchor", resourceId = "anchor", x = 300, y = 40).toTreeNode(),
        )).map { it.attributes.getValue("key") },
    ),
    treeVector(
        "position-unusable-bounds",
        "intersect(id=candidate, below(id=anchor)) excludes missing bounds",
        listOf(
            node("candidate-missing", resourceId = "candidate", y = 200, hasBounds = false),
            node("candidate-valid", resourceId = "candidate", y = 200),
            node("anchor-missing", resourceId = "anchor", y = 100, hasBounds = false),
            node("anchor-valid", resourceId = "anchor", y = 100),
        ),
        TreeSelector(id = "candidate", below = TreeSelector(id = "anchor")),
        intersect(id("candidate"), below(id("anchor"))),
    ),
    treeVector(
        "position-odd-center-integer-distance",
        "relativeTo uses Bounds.center integer division and Point.distance Float",
        listOf(
            node("candidate-odd", resourceId = "candidate", x = 1, y = 1, width = 1, height = 1),
            node("candidate-even", resourceId = "candidate", x = 0, y = 2, width = 0, height = 0),
            node("anchor", resourceId = "anchor", x = 0, y = 0, width = 0, height = 0),
        ),
        TreeSelector(id = "candidate", below = TreeSelector(id = "anchor")),
        intersect(id("candidate"), below(id("anchor"))),
        intermediateRelation = "below",
        intermediate = below(id("anchor"))(listOf(
            node("candidate-odd", resourceId = "candidate", x = 1, y = 1, width = 1, height = 1).toTreeNode(),
            node("candidate-even", resourceId = "candidate", x = 0, y = 2, width = 0, height = 0).toTreeNode(),
            node("anchor", resourceId = "anchor", x = 0, y = 0, width = 0, height = 0).toTreeNode(),
        )).map { it.attributes.getValue("key") },
    ),
    treeVector(
        "position-zero-size-finite-bounds",
        "intersect(id=candidate, below(id=anchor)) keeps zero-sized finite bounds",
        listOf(
            node("candidate-positive", resourceId = "candidate", x = 20, y = 180),
            node("candidate-zero", resourceId = "candidate", x = 10, y = 200, width = 0, height = 0),
            node("anchor-zero", resourceId = "anchor", x = 10, y = 100, width = 0, height = 0),
        ),
        TreeSelector(id = "candidate", below = TreeSelector(id = "anchor")),
        intersect(id("candidate"), below(id("anchor"))),
    ),
    treeVector(
        "position-composed-intersection-index",
        "compose(intersect(id=candidate, below(id=lower), above(id=upper)), index=0)",
        listOf(
            node("candidate-low", resourceId = "candidate", x = 0, y = 200),
            node("candidate-high", resourceId = "candidate", x = 100, y = 120),
            node("lower", resourceId = "lower", x = 0, y = 300),
            node("upper", resourceId = "upper", x = 0, y = 80),
        ),
        TreeSelector(
            id = "candidate",
            index = 0,
            below = TreeSelector(id = "upper"),
            above = TreeSelector(id = "lower"),
        ),
        intersect(id("candidate"), below(id("upper")), above(id("lower"))),
        Filters.compose(
            intersect(id("candidate"), below(id("upper")), above(id("lower"))),
            Filters.index(0),
        ),
    ),
    treeVector(
        "nested-tree-position-relation",
        "intersect(id=card, containsChild(below(id=caption)))",
        listOf(
            node(
                "card",
                children = listOf(
                    node("caption", resourceId = "caption", x = 20, y = 40),
                    node("field", resourceId = "field", x = 20, y = 120),
                ),
            ),
            node(
                "bad-card",
                resourceId = "card",
                children = listOf(
                    node("bad-field", resourceId = "field", x = 20, y = 20),
                    node("bad-caption", resourceId = "caption", x = 20, y = 80),
                ),
            ),
        ),
        TreeSelector(
            id = "card",
            containsChild = TreeSelector(id = "field", below = TreeSelector(id = "caption")),
        ),
        intersect(id("card"), child(below(id("caption")), id("field"))),
    ),
)

private fun treeVector(
    id: String,
    operation: String,
    roots: List<NodeSpec>,
    selector: TreeSelector,
    filter: ElementFilter,
    selectionFilter: ElementFilter? = null,
    intermediateRelation: String? = null,
    intermediate: List<String>? = null,
    emitClickableOrder: Boolean = false,
): TreeVector {
    val flattened = roots.flatMap { it.toTreeNode().aggregate() }
    val matches = filter(flattened).map { it.attributes.getValue("key") }
    val finalSelectionFilter = selectionFilter ?: Filters.compose(filter, Filters.clickableFirst())
    val finalSelection = finalSelectionFilter(flattened).map { it.attributes.getValue("key") }
    return TreeVector(
        id,
        operation,
        selector,
        roots.flatMap { it.toFixtureNodes() },
        matches,
        finalSelection.firstOrNull(),
        intermediateRelation,
        intermediate,
        if (emitClickableOrder) finalSelection else null,
    )
}

private fun id(value: String): ElementFilter = Filters.idMatches(Regex(value))
private fun text(value: String): ElementFilter = Filters.textMatches(Regex(value))
private fun child(filter: ElementFilter): ElementFilter = Filters.containsChild(filter)
private fun descendants(vararg filters: ElementFilter): ElementFilter = Filters.containsDescendants(filters.toList())
private fun intersect(vararg filters: ElementFilter): ElementFilter = Filters.intersect(filters.toList())
private fun below(anchor: ElementFilter): ElementFilter = Filters.below(anchor)
private fun above(anchor: ElementFilter): ElementFilter = Filters.above(anchor)
private fun leftOf(anchor: ElementFilter): ElementFilter = Filters.leftOf(anchor)
private fun rightOf(anchor: ElementFilter): ElementFilter = Filters.rightOf(anchor)
private fun child(relation: ElementFilter, base: ElementFilter): ElementFilter =
    Filters.containsChild(intersect(base, relation))
private fun composedTreeFilter(): ElementFilter = intersect(id("card"), child(id("title")), descendants(id("icon")))

private fun node(
    key: String,
    resourceId: String = key,
    x: Int = 0,
    y: Int = 0,
    text: String? = null,
    children: List<NodeSpec> = emptyList(),
    hasBounds: Boolean = true,
    width: Int = 40,
    height: Int = 30,
    clickable: Boolean? = null,
): NodeSpec = NodeSpec(key, resourceId, x, y, text, children, hasBounds, width, height, clickable)

private fun NodeSpec.toTreeNode(): TreeNode {
    val attributes = mutableMapOf("key" to key, "resource-id" to resourceId)
    if (hasBounds) attributes["bounds"] = "[$x,$y][${x + width},${y + height}]"
    text?.let { attributes["text"] = it }
    return TreeNode(
        attributes = attributes,
        children = children.map { it.toTreeNode() },
        clickable = clickable,
    )
}

private fun NodeSpec.toFixtureNodes(parentKey: String? = null): List<FixtureNode> = listOf(
    FixtureNode(
        key,
        parentKey,
        resourceId,
        text,
        if (hasBounds) FixtureRect(x, y, width, height) else null,
        clickable,
    ),
) + children.flatMap { it.toFixtureNodes(key) }
