import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "PCB2gcode",
	description: "PCB2gcode toolpath simulator.",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html
			lang="en"
			className="h-screen overflow-hidden antialiased"
			suppressHydrationWarning
		>
		<body className="min-h-full bg-[#101211] text-[#e9ece9]">
			{children}
		</body>
		</html>
	);
}
