"""Two synthetic rigs and a Blender-owned Action asset, for the real acceptance job."""
import bpy
import sys

path = sys.argv[sys.argv.index('--') + 1]
bpy.ops.object.armature_add()
first = bpy.context.object
first.name = 'PoseActorA'
first.pose.bones[0].rotation_mode = 'XYZ'
first.pose.bones[0].location.x = 0.75
first.pose.bones[0].keyframe_insert(data_path='location', frame=1)
action = first.animation_data.action
action.name = 'LeanPose'
action.asset_mark()
action.use_fake_user = True
first.animation_data_clear()
first.pose.bones[0].location.x = 0
second = first.copy()
second.name = 'PoseActorB'
bpy.context.scene.collection.objects.link(second)
assert second.data == first.data
# An animated target is deliberately unsupported; its animation must not be removed.
second.animation_data_create().action = action
second.animation_data.action_slot = action.slots[0]
bpy.context.scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=path)
