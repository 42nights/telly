import { Column, Host, Text as ExpoUIText } from "@expo/ui";
import { View, ScrollView, StyleSheet } from "react-native";

import { Container } from "@/components/container";
import { NAV_THEME } from "@/lib/constants";
import { useColorScheme } from "@/lib/use-color-scheme";

export default function Home() {
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === "dark" ? NAV_THEME.dark : NAV_THEME.light;

  return (
    <Container>
      <ScrollView style={styles.scrollView} contentInsetAdjustmentBehavior="never">
        <View style={styles.content}>
          <Host style={styles.titleHost}>
            <ExpoUIText
              textStyle={{
                color: theme.text,
                fontSize: 24,
                fontWeight: "bold",
                textAlign: "center",
              }}
            >
              BETTER T STACK
            </ExpoUIText>
          </Host>

          <View
            style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
          ></View>
        </View>
      </ScrollView>
    </Container>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 32,
  },
  titleHost: {
    alignSelf: "stretch",
    height: 34,
    marginBottom: 24,
  },
  card: {
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusIndicator: {
    height: 10,
    width: 10,
    borderRadius: 999,
  },
  statusContent: {
    flex: 1,
  },
  userCard: {
    marginBottom: 16,
    padding: 16,
    borderWidth: 1,
    borderRadius: 16,
  },
  userHeader: {
    marginBottom: 8,
  },
  paymentActions: {
    marginTop: 12,
  },
  authHost: {
    marginBottom: 12,
  },
  authActionsHost: {
    marginTop: 4,
  },
  statusCard: {
    marginBottom: 16,
    padding: 16,
    borderWidth: 1,
    borderRadius: 16,
  },
  statusCardTitleHost: {
    marginBottom: 8,
  },
});
