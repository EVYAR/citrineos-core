// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { QueryInterface } from 'sequelize';

export default {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        LOCK TABLE public."Transactions", public."MeterValues" IN SHARE ROW EXCLUSIVE MODE;
        DO $$
        DECLARE
          binding record;
          function_oid oid;
          existing pg_trigger%ROWTYPE;
        BEGIN
          FOR binding IN SELECT * FROM (VALUES
            ('Transactions', 'TransactionNotification', 'TransactionNotify', 21, 'INSERT OR UPDATE'),
            ('MeterValues', 'MeterValueNotification', 'MeterValueNotify', 5, 'INSERT')
          ) AS bindings(table_name, trigger_name, function_name, trigger_type, events)
          LOOP
            function_oid := to_regprocedure(format('public.%I()', binding.function_name));
            IF function_oid IS NULL OR NOT EXISTS (
              SELECT 1 FROM pg_proc WHERE oid = function_oid AND prorettype = 'trigger'::regtype
            ) THEN
              RAISE EXCEPTION 'OCPI_NOTIFICATION_FUNCTION_MISSING: %', binding.function_name;
            END IF;

            IF EXISTS (
              SELECT 1 FROM pg_trigger
              WHERE tgrelid = to_regclass(format('public.%I', binding.table_name))
                AND tgfoid = function_oid AND tgname <> binding.trigger_name
            ) THEN
              RAISE EXCEPTION 'OCPI_NOTIFICATION_BINDING_CONFLICT: %', binding.trigger_name;
            END IF;

            SELECT * INTO existing FROM pg_trigger
            WHERE tgrelid = to_regclass(format('public.%I', binding.table_name))
              AND tgname = binding.trigger_name;
            IF FOUND THEN
              IF existing.tgisinternal OR existing.tgfoid <> function_oid
                OR existing.tgtype <> binding.trigger_type OR existing.tgenabled <> 'O'
                OR existing.tgnargs <> 0 OR existing.tgqual IS NOT NULL
                OR existing.tgattr::text <> '' OR existing.tgconstraint <> 0
                OR existing.tgparentid <> 0
              THEN
                RAISE EXCEPTION 'OCPI_NOTIFICATION_BINDING_CONFLICT: %', binding.trigger_name;
              END IF;
            ELSE
              EXECUTE format(
                'CREATE TRIGGER %I AFTER %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()',
                binding.trigger_name, binding.events, binding.table_name, binding.function_name
              );
            END IF;
          END LOOP;
        END;
        $$;
        `,
        { transaction },
      );
    });
  },
  down: async () => {
    // Binding provenance is not persisted: removing it could break a preexisting working installation.
    // Keep the repaired bindings on rollback; the historic OCPI migrations own their removal.
  },
};
