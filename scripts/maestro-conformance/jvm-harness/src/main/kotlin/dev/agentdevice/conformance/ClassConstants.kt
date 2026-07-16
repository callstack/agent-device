package dev.agentdevice.conformance

import org.objectweb.asm.ClassReader
import org.objectweb.asm.ClassVisitor
import org.objectweb.asm.FieldVisitor
import org.objectweb.asm.Opcodes

/**
 * Reads a `static final` field's compile-time constant straight out of the
 * pinned bytecode via its `ConstantValue` attribute. This never loads or
 * initializes the declaring class, so it is safe against `maestro.Maestro` /
 * `maestro.drivers.*Driver`, whose `<clinit>` pulls in driver/native state.
 *
 * The value is genuinely extracted from the resolved jar — not transcribed —
 * which is the whole point of the semantic-vector layer.
 */
fun readConstant(internalClassName: String, fieldName: String): Any {
    val resource = "$internalClassName.class"
    val bytes = Thread.currentThread().contextClassLoader.getResourceAsStream(resource)
        ?.use { it.readBytes() }
        ?: error("Class resource not found on the pinned classpath: $resource")

    var found: Any? = null
    ClassReader(bytes).accept(object : ClassVisitor(Opcodes.ASM9) {
        override fun visitField(
            access: Int,
            name: String,
            descriptor: String,
            signature: String?,
            value: Any?,
        ): FieldVisitor? {
            if (name == fieldName) {
                found = value
                    ?: error("Field $internalClassName#$fieldName has no ConstantValue attribute.")
            }
            return null
        }
    }, ClassReader.SKIP_CODE or ClassReader.SKIP_DEBUG or ClassReader.SKIP_FRAMES)

    return found ?: error("Field $internalClassName#$fieldName not found in the pinned bytecode.")
}
