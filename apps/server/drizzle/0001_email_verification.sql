CREATE TABLE `email_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_verifications_token_hash_unique` ON `email_verifications` (`token_hash`);--> statement-breakpoint
CREATE INDEX `email_verifications_user_idx` ON `email_verifications` (`user_id`);--> statement-breakpoint
CREATE INDEX `email_verifications_expires_idx` ON `email_verifications` (`expires_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified_at` integer;--> statement-breakpoint
--
-- Accounts that predate email verification are grandfathered in.
--
-- They were created when no confirmation was ever asked for, so there is no address to
-- re-confirm and no link they could be expected to still have. Leaving them NULL would
-- lock every existing user -- including the operator -- out of a running deployment the
-- moment this migration ships.
--
UPDATE `users` SET `email_verified_at` = `created_at` WHERE `email_verified_at` IS NULL;
