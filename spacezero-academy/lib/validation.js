'use strict';

const { z } = require('zod');
const { MIN_PASSWORD_LENGTH } = require('./password');

const LoginSchema = z.object({
  identifier: z.string().trim().min(1, "Enter your username or email."),
  password: z.string().min(1, 'Enter your password.'),
});

const ForgotPasswordSchema = z.object({
  email: z.email('Enter a valid email address.').trim(),
});

const SetPasswordSchema = z
  .object({
    password: z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`).max(72),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    error: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

const usernamePattern = /^[a-z0-9][a-z0-9._-]{2,29}$/;

const EmployeeSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the full name.'),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(usernamePattern, "Username must be 3-30 characters: lowercase letters, digits, '.', '_' or '-'."),
  email: z.email('Enter a valid email address.').trim().toLowerCase(),
  role: z.enum(['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT']),
  teamId: z.string().trim().optional().nullable(),
  supervisorId: z.string().trim().optional().nullable(),
  employmentStartDate: z.iso.date('Enter a valid employment start date.'),
});

const EmployeeUpdateSchema = EmployeeSchema.omit({ username: true, email: true });

const TeamSchema = z.object({
  name: z.string().trim().min(2, 'Enter the team name.'),
  description: z.string().trim().optional(),
});

const ModuleContentTypeEnum = z.enum(['VIDEO', 'AUDIO', 'PDF', 'PPT', 'DOC', 'IMAGE', 'NOTE', 'LINK', 'QUIZ']);

const ModuleInputSchema = z.object({
  title: z.string().trim().min(1, 'Module title is required.'),
  description: z.string().trim().optional(),
  contentType: ModuleContentTypeEnum,
  externalUrl: z.string().trim().refine(v => !v || /^https?:\/\//i.test(v), 'Use an HTTP or HTTPS URL.').optional(),
  durationMinutes: z.coerce.number().int().positive().optional(),
});

// 70 is the spec's hardcoded organization-wide passing-score floor for mandatory training —
// a course may configure a higher threshold, never lower.
const MIN_PASSING_SCORE = 70;

const CourseSchema = z.object({
  title: z.string().trim().min(2, 'Enter a course title.'),
  description: z.string().trim().optional(),
  roleKey: z.enum(['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT', '']).optional(),
  mandatory: z.boolean(),
  // 50 is the absolute floor an Admin could ever configure; the organization's actual minimum (default 70) is checked in the routes.
  passingScore: z.coerce.number().int().min(50, 'Passing score cannot be below 50%.').max(100),
});

const AssignmentSchema = z.object({
  courseId: z.string().min(1, 'Select a course.'),
  scope: z.enum(['INDIVIDUAL', 'TEAM', 'ROLE', 'COMPANY']),
  targetProfileIds: z.array(z.string()).optional(),
  targetTeamId: z.string().optional(),
  targetTeamIds: z.array(z.string()).optional(),
  targetRole: z.enum(['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT']).optional(),
  dueDate: z.string().optional(),
  notes: z.string().optional(),
});

const LibraryItemTypeEnum = z.enum(['VIDEO', 'AUDIO', 'PDF', 'PPT', 'DOC', 'IMAGE', 'NOTE', 'LINK']);

const LibraryItemSchema = z.object({
  title: z.string().trim().min(2, 'Enter a title.'),
  description: z.string().trim().optional(),
  categoryId: z.string().trim().optional(),
  itemType: LibraryItemTypeEnum,
  externalUrl: z.string().trim().refine(v => !v || /^https?:\/\//i.test(v), 'Use an HTTP or HTTPS URL.').optional(),
  tags: z.string().trim().optional(),
  visibleRoles: z.array(z.enum(['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT'])).optional(),
});

const LibraryCategorySchema = z.object({
  name: z.string().trim().min(2, 'Enter a category name.'),
});

const TenureBandSchema = z.object({
  label: z.string().trim().min(1, 'Enter a label.'),
  minMonths: z.coerce.number().int().min(0),
  maxMonths: z.string().optional(),
  displayOrder: z.coerce.number().int().default(0),
});

const SkillSchema = z.object({
  name: z.string().trim().min(1, 'Enter a skill name.'),
  roleKey: z.enum(['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT', '']),
  category: z.string().trim().optional(),
});

const SkillEvidenceSchema = z.object({ notes: z.string().trim().min(10).max(5000) });

const PracticeMaterialTypeEnum = z.enum(['CALL', 'VIDEO', 'PDF', 'SLIDES', 'DOC', 'NOTE']);

const ContactInfoSchema = z.object({
  phonePrimary: z.string().trim().max(40).optional(),
  phoneSecondary: z.string().trim().max(40).optional(),
  whatsappNumber: z.string().trim().max(40).optional(),
  telegramContact: z.string().trim().max(40).optional(),
  phoneUzbekistan: z.string().trim().max(40).optional(),
});

const PracticeMaterialSchema = z.object({
  title: z.string().trim().min(2, 'Enter a title.'),
  description: z.string().trim().optional(),
  materialType: PracticeMaterialTypeEnum,
  noteContent: z.string().trim().optional(),
});

const NoteSchema = z.object({
  title: z.string().trim().max(200).optional(),
  content: z.string().trim().min(1, 'Write something before saving.').max(20000),
});

module.exports = {
  LoginSchema,
  ForgotPasswordSchema,
  SetPasswordSchema,
  EmployeeSchema,
  EmployeeUpdateSchema,
  TeamSchema,
  ModuleInputSchema,
  CourseSchema,
  MIN_PASSING_SCORE,
  AssignmentSchema,
  LibraryItemSchema,
  LibraryCategorySchema,
  TenureBandSchema,
  SkillSchema,
  SkillEvidenceSchema,
  NoteSchema,
  PracticeMaterialSchema,
  ContactInfoSchema,
};
