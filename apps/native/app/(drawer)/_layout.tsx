import { Ionicons } from "@expo/vector-icons";
import { Drawer } from "expo-router/drawer";

import { NAV_THEME } from "@/lib/constants";
import { useColorScheme } from "@/lib/use-color-scheme";

const DrawerLayout = () => {
	const { colorScheme } = useColorScheme();
	const theme = colorScheme === "dark" ? NAV_THEME.dark : NAV_THEME.light;

	return (
		<Drawer
			screenOptions={{
				headerStyle: {
					backgroundColor: theme.background,
				},
				headerTitleStyle: {
					color: theme.text,
				},
				headerTintColor: theme.text,
				drawerStyle: {
					backgroundColor: theme.background,
				},
				drawerLabelStyle: {
					color: theme.text,
				},
				drawerInactiveTintColor: theme.text,
			}}
		>
			<Drawer.Screen
				name="index"
				options={{
					headerTitle: "Home",
					drawerLabel: "Home",
					drawerIcon: ({ size, color }) => (
						<Ionicons name="home-outline" size={size} color={color} />
					),
				}}
			/>
			<Drawer.Screen
				name="sign-in"
				options={{
					headerTitle: "Sign in",
					drawerLabel: "Sign in",
					drawerIcon: ({ size, color }) => (
						<Ionicons name="key-outline" size={size} color={color} />
					),
				}}
			/>
		</Drawer>
	);
};

export default DrawerLayout;
