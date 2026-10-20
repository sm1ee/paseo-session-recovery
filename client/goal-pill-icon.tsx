import type { PluginButtonIconProps } from "@getpaseo/plugin/client";
import { useEffect } from "react";
import { View } from "react-native";

// Paseo mounts an icon only when its composer's button is on screen. Checking
// that one session avoids thousands of goal lookups on each phone/reconnect.
export function GoalPillIcon({ size, color, observe }: PluginButtonIconProps & { observe: () => () => void }) {
  useEffect(observe, [observe]);
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
    <View style={{ width: size - 2, height: size - 2, borderRadius: size, borderWidth: 1.5, borderColor: color, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: size / 3, height: size / 3, borderRadius: size, borderWidth: 1.5, borderColor: color }} />
    </View>
  </View>;
}
